# H3 — Public MCP surface has no per-tool rate limit (DoS / DB-cost amplification)

|                       |                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Original severity** | High                                                                                                                                                               |
| **Verified verdict**  | Confirmed · Severity unchanged                                                                                                                                     |
| **Confidence**        | CONFIRMED                                                                                                                                                          |
| **Domain**            | mcp                                                                                                                                                                |
| **Modules / files**   | `src/app/build-redesign-app.ts`, `src/redesign-api.ts`, `src/modules/shared/shell/mcp/*`, `src/modules/shared/core/usecases/entity-360.ts`, `src/app/build-app.ts` |
| **Fix effort**        | S–M                                                                                                                                                                |
| **Merge-blocker?**    | yes (standalone redesign server); owner-call for legacy mount                                                                                                      |
| **Workflow status**   | Deferred by owner (2026-07-17)                                                                                                                                     |

## TL;DR

The public, unauthenticated `POST /api/v1/mcp` surface dispatches every MCP tool with **no per-tool and no per-key throttle**. The kernel _does_ ship an in-process token-bucket `RateLimiter`, but it is consulted at exactly **one** call site — the GraphQL `searchEntities` resolver — and **never** on the MCP path. The most expensive reachable tool, `get_entity_snapshot`, eagerly runs flows-in + flows-out over the ~19 GB flow graph **plus** a known ~7 s unindexed `any(cuis)` scan over 6.1 M search docs, for any caller-supplied CUI, on every call. On the **standalone** redesign server (`redesign-api.ts` → `buildRedesignApp`) there is no `@fastify/rate-limit` at all, so a single client can loop this tool with zero limit. Fix: gate the MCP dispatcher with the kernel `RateLimiter` (per-key, per-tool cost weighting) and register `@fastify/rate-limit` in `buildRedesignApp`.

## Owner decision (2026-07-17)

Deferred while `REDESIGN_SURFACE_ENABLED` remains disabled. Do not enable the
redesign surface until this issue is resolved. Because H4 is also deferred, an
IP-only limiter is not sufficient; a future fix must include an IP-independent
global cost/concurrency guard or resolve H4 before relying on per-IP buckets.

## Evidence (re-verified against current code)

**1. MCP mount is public and unthrottled (standalone).**
`src/app/build-redesign-app.ts:435`

```ts
app.post('/api/v1/mcp', async (request, reply) => {
  const response = await mcpDispatcher.dispatch(request.body);
  if (response === null) return reply.code(202).send();
  return reply.code(200).send(response);
});
```

`buildRedesignApp` (lines 148–196) registers **only** `@fastify/cors` and then `registerRedesignSurface`. Grep for any limiter in the standalone graph returns nothing:

- `grep -n "rate\|limiter" src/redesign-api.ts src/app/build-redesign-app.ts` → **no matches**.

So the standalone redesign server (`src/redesign-api.ts:15` → `buildRedesignApp`, `:38` `app.listen`) serves `/api/v1/mcp` with **zero** request-count or cost throttling.

**2. The kernel RateLimiter is consulted on exactly one path — never MCP.**
`grep -rn "\.consume(" src/` returns only two hits:

- `src/modules/shared/shell/graphql/resolvers.ts:100` — `deps.rateLimiter.consume(\`searchEntities:${ip}\`)` (GraphQL only).
- `src/modules/user-data/core/usecases/shared.ts:72` — an unrelated per-owner mutation limiter.

The limiter is created once at `src/modules/shared/index.ts:160` (`createRateLimiter({ maxTokens: 30, windowMs: 60_000 })`) and injected into the resolvers only. `makeKernelMcpTools` (`src/modules/shared/shell/mcp/tools.ts`) receives no limiter and **none of the tool handlers call `consume`**. Notably the MCP `search_entities` tool (`tools.ts:119`) is the _same_ global search that GraphQL rate-limits — but over MCP it is completely unguarded.

**3. `get_entity_snapshot` is eager and expensive.**
`src/modules/shared/shell/mcp/tools.ts:80-117` — handler calls `makeEntity360(deps.entity360Deps, cui)`.
`src/modules/shared/core/usecases/entity-360.ts:104-111` runs, in one `Promise.all` on every call:

```ts
identityRepo.findByCui(cui),
identityRepo.territoryForCui(cui),
flowsRepo.getFlowSummary(cui, 'in'),   // flows.money_flows — the 19GB graph (§14.6)
flowsRepo.getFlowSummary(cui, 'out'),  // 19GB graph again
searchRepo.countByCui(cui),            // ~7s any(cuis) scan, no index
Promise.all(registry.list().map(c => c.presenceFor(cui))),  // per-source fan-out
```

The in-code cost annotations are explicit — `entity-360.ts:50` (`documentCount → any(cuis) over 6.1M search docs (~7s, no index)`) and `:117-118` (`known-slow any(cuis) scan over 6.1M docs (no index yet)`). The `~7s` claim is corroborated at `src/modules/shared/shell/graphql/resolvers.ts:135`.

**4. The count really is a full scan.**
`src/modules/shared/shell/repo/search-repo.ts:21-32`:

```ts
.selectFrom('search.documents')
.select(sql<string>`count(*)`.as('total'))
.where(sql<boolean>`${cui} = any(cuis)`)
```

`count(*)` over `<cui> = any(cuis)` with no supporting index → full table scan of 6.1 M rows. (The file's header comment "never an unbounded scan" applies to `fallbackTextSearch`, which is `LIMIT`-capped; it does **not** apply to `countByCui`, which is uncapped.)

**5. Auth is intentionally public — throttling is the only defense.**
`src/app/build-app.ts:352-360` lists `/api/v1/mcp` in `REDESIGN_SURFACE_ROUTE_PATHS`, and `:505-511` exempts those paths from the legacy global-auth preHandler ("Public read-only data — the standalone redesign server has no auth"). There is no API key, no session, no Clerk check on this route. (Contrast the `/api/v1/agent` surface, which _is_ Clerk-authed inside its plugin — `build-app.ts:1126-1127`.)

**6. The only cost bound today is a 30 s response timeout — and it does not cancel DB work.**
`src/modules/shared/shell/mcp/http-dispatch.ts:124-135` arms a 30 s timer that _resolves the HTTP promise_ with an error, then `finally { await server.close() }` (`:136-139`). It passes **no** `AbortSignal` into the tool handler or the Kysely query. So on timeout the client gets a fast error response, but the underlying `count(*) any(cuis)` scan and 19 GB flow reads keep running to completion on the DB. This makes the timeout _worse_ for DoS: an attacker is unblocked in 30 s to fire the next request while the previous query still burns a connection.

## Root cause

The kernel built a per-key token-bucket limiter but wired it into a single GraphQL resolver instead of the shared dispatch layer that both GraphQL and MCP flow through. The MCP dispatcher (`buildMcpDispatcher` → `createMcpHttpDispatcher`) has no limiter dependency at all, and the standalone `buildRedesignApp` never registers Fastify-level rate limiting. Auth being deliberately off for this public surface means throttling is the _only_ available control, and it is absent.

## Blast radius & impact

- **Standalone redesign server (`redesign-api.ts`): fully unthrottled.** Any internet client can loop `get_entity_snapshot`. Each call = 2× flow-summary reads over the 19 GB `flows.money_flows` graph + one ~7 s unindexed 6.1 M-row `count(*)` scan + per-contributor fan-out. The CUI need not exist — an invalid/absent CUI still triggers the `any(cuis)` scan (it returns 0 after scanning).
- **Connection-pool exhaustion.** Per `CLAUDE.md` the Kysely pool is 10 connections per client. `makeEntity360` issues ~5–6 concurrent queries per call; the slowest (`countByCui`) holds a connection ~7 s. A single client issuing ~2 concurrent snapshot requests can pin all 10 connections for seconds; a handful of looping clients starves the pool for **all** traffic (GraphQL, health/ready), turning a cheap request flood into a full-surface outage. The 30 s dispatcher timeout does **not** release the DB connection early (evidence #6), so pool pressure outlives the HTTP response.
- **Amplification factor.** Request cost to the attacker: one small JSON-RPC POST. Cost to the server: multi-second multi-query DB load. That asymmetry is the DoS.
- **Cost/DoS, not data exposure.** This is availability + infra-cost, not a confidentiality leak.

**What bounds it:** On the **legacy** combined server (`buildApp`), the global `@fastify/rate-limit` at `build-app.ts:807-816` is registered on the root `app` _before_ the redesign child scope is mounted (`:1194`), so its `onRequest` hook is inherited by `/api/v1/mcp` on that server. That caps **request count** per IP (`config.rateLimit.max` / `timeWindow`) — but it is coarse: every tool costs exactly 1, so N cheap `resolve_entity` calls and N `get_entity_snapshot` scans are treated identically. It also keys on IP, which ties into H4 (trustProxy spoofing lets an attacker rotate the key). The standalone server has **no** such backstop.

## Reproduction / falsifiable scenario

Against the standalone redesign server:

```bash
# One expensive call
curl -s localhost:3000/api/v1/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"get_entity_snapshot","arguments":{"cui":"99999999"}}
}'
# ~7s to respond (or a 30s dispatcher timeout under load), full 6.1M-row scan each time.

# Flood: loop it with modest concurrency and watch the pool starve
seq 1 200 | xargs -P 20 -I{} curl -s -o /dev/null localhost:3000/api/v1/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{"name":"get_entity_snapshot","arguments":{"cui":"{}"}}}'
```

Expected: `/api/v1/graphql` and `/api/v1/ready` latency spikes / 503s as the 10-connection pool is exhausted; no 429 is ever returned (no limiter). Falsifiable by observing that requests never receive a rate-limit rejection and that concurrent unrelated queries stall.

## Additional context discovered

- **MCP `search_entities` bypasses the very guard GraphQL relies on.** The GraphQL `searchEntities` resolver is explicitly rate-limited "because it has no other guard" (`resolvers.ts:96-105`), yet the identical MCP tool (`tools.ts:119`) has no limiter — a direct inconsistency the fix should close in one place.
- **`aggregate_procurement`** (`procurement/shell/mcp/tools.ts:221`) is rollup/MV-backed (recent commits: "rollup-backed analysis serving surface"), so per-call cost is bounded — lower priority than the snapshot. **`search_procurement_direct_acquisitions`** (`:163`) requires a selective filter and is cursor-paginated (`first` capped at 100), bounding it. So the standout unbounded tool is `get_entity_snapshot`.
- **Timeout is unref'd** (`http-dispatch.ts:133`) and does not abort DB work — worth an `AbortSignal` wired into the repos regardless of the rate-limit fix.
- No test covers MCP throttling (none exists to cover). A regression test should assert a 429/`RATE_LIMITED` after N MCP calls per key.

## Fix options

**Option A (recommended) — throttle at the MCP dispatcher, per key + per-tool cost.**
Inject the existing kernel `RateLimiter` into `buildMcpDispatcher`/`createMcpHttpDispatcher` and consume before dispatching a `tools/call`, keyed by `mcp:${clientKey}` with a per-tool cost weight (e.g. `get_entity_snapshot` = 10, `search_entities` = 5, `resolve_entity` = 1). Concrete integration point: `src/app/build-redesign-app.ts:435-439` — the handler already has `request`, so derive the key there and pass tool name + cost into `dispatch`. This reuses the built limiter, covers standalone **and** legacy mounts uniformly, and gives cost-proportional protection the coarse Fastify limiter cannot. Add a token-cost table alongside the tool registry.

**Option B — register `@fastify/rate-limit` in `buildRedesignApp`.**
Add `await app.register(rateLimit, { max, timeWindow })` in `buildRedesignApp` (mirroring `build-app.ts:807-816`) so the standalone server gets at least request-count protection. Cheapest change, closes the standalone gap, but stays coarse (all tools cost 1) and does not address the flow-graph/scan amplification per request.

**Recommended: A, with B as a defense-in-depth backstop.** Both share the **IP-key caveat of H4**: with `trustProxy: true` (`build-redesign-app.ts:152`), a client can spoof `X-Forwarded-For` to rotate the rate-limit key and evade per-IP buckets. The rate-limit fix must land together with H4's trusted-proxy hardening, otherwise the per-key limiter is trivially bypassed.

Independently of the limiter: pass an `AbortSignal` from the 30 s dispatcher timeout into `makeEntity360`'s queries so a timed-out request stops burning a DB connection.

**Test to pin it:** an MCP integration test that fires N+1 `get_entity_snapshot` calls from one key and asserts the (N+1)th is rejected with the structured rate-limit error; plus a standalone-app test asserting `buildRedesignApp` registers a limiter.

## Related

- [H4](H4-trustproxy-rate-limit-bypass.md) — trustProxy lets `X-Forwarded-For` spoofing rotate the per-IP key; blocks the effectiveness of any IP-keyed limiter here.
- Medium cluster 2 (mcp/procurement/CORS) — per-tool cost weighting and the unref'd/no-abort dispatcher timeout.
- Main report §MCP surface hardening.
