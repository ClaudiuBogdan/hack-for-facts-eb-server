# H4 — `trustProxy: true` lets a client-supplied `X-Forwarded-For` spoof `request.ip`, defeating every per-IP rate limit

|                       |                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | High                                                                                                                                                                                                                                                                                                                                                                         |
| **Verified verdict**  | Confirmed · Severity unchanged                                                                                                                                                                                                                                                                                                                                               |
| **Confidence**        | CONFIRMED                                                                                                                                                                                                                                                                                                                                                                    |
| **Domain**            | auth                                                                                                                                                                                                                                                                                                                                                                         |
| **Modules / files**   | `src/app/build-redesign-app.ts:152`, `src/api.ts:169`, `src/infra/config/env.ts:197-231,382,425`, `src/modules/shared/shell/graphql/resolvers.ts:74-105`, `src/modules/shared/shell/middleware/rate-limiter.ts`, `src/app/build-app.ts:807-816`, `src/modules/mcp/shell/rest/routes.ts:149`, `src/modules/mcp/shell/rest/gpt-routes.ts:153`, `k8s/base/virtual-service.yaml` |
| **Fix effort**        | S                                                                                                                                                                                                                                                                                                                                                                            |
| **Merge-blocker?**    | yes                                                                                                                                                                                                                                                                                                                                                                          |

## TL;DR

Both server entry points build Fastify with `trustProxy: true` (the standalone redesign app hardcodes it; the legacy app defaults to it). Fastify then hands `proxy-addr` a "trust everything" predicate, so `request.ip` becomes the **leftmost, fully attacker-controlled** value of the `X-Forwarded-For` chain. Every abuse control in the codebase keys on that IP — the kernel `searchEntities` token bucket, the two MCP rate limiters, and the global `@fastify/rate-limit` — so an attacker bypasses all of them by rotating one HTTP header. The Istio ingress gateway does **not** mitigate this: it _appends_ the real client IP to the right of the forged header rather than stripping it, and `trustProxy: true` deliberately trusts the whole chain. Fix: replace `true` with the exact number of trusted proxy hops (or a trusted CIDR) on both paths.

## Evidence (re-verified against current code)

**1. Standalone redesign app hardcodes `trustProxy: true`** — `src/app/build-redesign-app.ts:148-153`:

```ts
const app = fastifyLib({
  logger: { level: deps.logLevel ?? 'info' },
  disableRequestLogging: true,
  trustProxy: true, // boolean true, not a hop count / CIDR
});
```

This value is not configurable — there is no env plumbing on this path.

**2. Legacy app defaults to `true`** — `src/api.ts:167-169`:

```ts
disableRequestLogging: true,
// Configurable via TRUST_PROXY env var (true, false, hop count, named proxy, or CIDR).
trustProxy: config.server.trustProxy ?? true,
```

`config.server.trustProxy` comes from `TRUST_PROXY` via `parseTrustProxy` (`src/infra/config/env.ts:204-231`, wired at `:382` and surfaced as `config.server.trustProxy` at `:425`). It is **`Type.Optional`** (`:197-199`) with no default, so when the env var is unset the `?? true` fallback applies. I grepped the entire deploy tree — `TRUST_PROXY` is set **nowhere** (`k8s/base/configmap.yaml`, `k8s/base/deployment.yaml` env block, both `argocd/applications/*.yaml`). So production runs with the boolean `true` on the legacy path too.

**3. `trustProxy: true` → `proxy-addr` trusts the entire chain → leftmost XFF wins.** Fastify 5.8.5 (`package.json`) resolves `request.ip` through `proxy-addr`. With a boolean `true`, Fastify passes a predicate that returns `true` for every hop. `proxy-addr` walks the XFF list right-to-left and stops at the first _untrusted_ address; when every hop is trusted it returns the **leftmost** entry. The leftmost entry is whatever the client sent — there is no untrusted hop to stop at. The code even documents the resulting behavior at `src/modules/shared/shell/graphql/resolvers.ts:65-72`:

```ts
// `reply.request.ip` is the caller IP (Fastify honors
// `X-Forwarded-For` because the app is built with `trustProxy: true`).
```

**4. The kernel search limiter keys on that IP** — `src/modules/shared/shell/graphql/resolvers.ts:74-105`:

```ts
const callerIp = (context) => context?.reply?.request?.ip ?? 'anon';
...
const ip = callerIp(context);
const limit = deps.rateLimiter.consume(`searchEntities:${ip}`);
if (!limit.allowed) { throw new GraphQLError('Rate limit exceeded ...'); }
```

The limiter is an in-process token bucket keyed by string (`src/modules/shared/shell/middleware/rate-limiter.ts:28-63`): a **new key gets a full bucket** (`tokens: config.maxTokens`, line 51). So each fresh spoofed IP starts unthrottled.

**5. Same spoofable key in the other three limiters:**

- Global `@fastify/rate-limit` (`src/app/build-app.ts:807-816`) — no custom `keyGenerator`, so it uses the plugin default, which is `request.ip`.
- MCP JSON-RPC route (`src/modules/mcp/shell/rest/routes.ts:149`): `const rateLimitKey = sessionIdHeader ?? request.ip;` — no session header → `request.ip`.
- MCP GPT route (`src/modules/mcp/shell/rest/gpt-routes.ts:153`): `const key = request.ip;`.

**6. Ingress topology does NOT strip inbound XFF** — `k8s/base/virtual-service.yaml` routes public traffic through the Istio ingress gateway (`istio-system/istio-https-gateway`). There is no `meshConfig.gatewayTopology.numTrustedProxies` / `xff_num_trusted_hops` setting anywhere in `k8s/` or `argocd/`. Istio/Envoy with default `use_remote_address=true` **appends** the connecting client's IP to the _right_ of any pre-existing XFF; it does not delete forged left-hand entries. Combined with `trustProxy: true` (which returns the leftmost), the edge does not help.

What I could not verify live: I did not run a request against a deployed pod to observe the resolved `request.ip`. The conclusion is derived from the documented `proxy-addr`/Envoy semantics plus the confirmed config values above.

## Root cause

`trustProxy: true` is a "trust every hop in `X-Forwarded-For`" instruction. It is only safe when the header cannot originate from the client — i.e., when a trusted edge **overwrites/sanitizes** XFF. Here the edge (Istio) only _appends_, and the app trusts the whole chain, so the leftmost value — chosen by the client — becomes `request.ip`. Every IP-keyed control inherits a caller-controlled key.

## Blast radius & impact

- **All four rate limiters are bypassable by any unauthenticated caller** with a single rotating header (`X-Forwarded-For: <random>`), giving each request a fresh, full bucket.
  - Kernel `searchEntities` (Meilisearch-backed, its only guard) → unbounded search load. Cross-reference **H3** (unthrottled/underthrottled public MCP): even where MCP _is_ throttled per IP, H4 makes that throttle ineffective, so H3 and H4 compound.
  - Global `@fastify/rate-limit` (`RATE_LIMIT_MAX: 300/min`, `configmap.yaml:17`) → the app-wide DoS backstop is void.
  - Both public MCP surfaces (H3 scope).
- **Secondary memory-growth / DoS:** the in-process bucket `Map` (`rate-limiter.ts:29`) is reaped only every 60 s and only for buckets idle > `windowMs*2` (lines 31-34). Rapid XFF rotation inserts unbounded distinct keys between reaps → attacker-driven heap growth in each pod.
- **Audit/observability integrity:** `request.ip` is logged as `remoteAddress` on every request (`src/app/build-app.ts:751` incoming, `:781` completed). A spoofable IP means **request logs and any IP-based forensics/abuse attribution are attacker-forgeable** — investigators chasing an incident will see whatever IP the attacker chose. This raises the practical severity beyond "just rate limits": it poisons the audit trail. (No allow/deny list or CORS decision keys on `request.ip` — CORS keys on `Origin`, `build-redesign-app.ts:168-179`. Admin lockdown is enforced at the gateway by path, `virtual-service.yaml:26-39`, not by IP, so that control is unaffected.)
- **Preconditions:** none beyond reaching the public endpoint. No auth, no session, no config drift required — the vulnerable config is the shipped default on both paths.

## Reproduction / falsifiable scenario

Against the kernel search limiter (same shape works for `/mcp` and global limits):

```bash
# Exhaust the bucket for one IP:
for i in $(seq 1 100); do
  curl -s https://api.transparenta.eu/api/v1/graphql \
    -H 'content-type: application/json' \
    -H 'X-Forwarded-For: 10.0.0.1' \
    -d '{"query":"{ searchEntities(q:\"a\"){ cui } }"}' >/dev/null
done
# → eventually RATE_LIMITED for 10.0.0.1

# Now rotate the header — every request is a brand-new full bucket, never limited:
for i in $(seq 1 100000); do
  curl -s https://api.transparenta.eu/api/v1/graphql \
    -H 'content-type: application/json' \
    -H "X-Forwarded-For: 10.0.$((RANDOM%255)).$((RANDOM%255))" \
    -d '{"query":"{ searchEntities(q:\"a\"){ cui } }"}' >/dev/null
done
```

Falsifiable check without traffic: exec into a running pod and hit any route with `-H 'X-Forwarded-For: 1.2.3.4'`; the request log line's `req.remoteAddress` (`build-app.ts:751`) will read `1.2.3.4`. If it instead shows the Istio/pod address, the edge is sanitizing XFF and this finding would downgrade — but no such Istio config exists in-repo.

## Additional context discovered

- **No test pins IP resolution.** There is no test asserting how `request.ip` is derived under `trustProxy`, nor that a spoofed XFF is rejected — nothing guards a fix from regressing.
- **`parseTrustProxy` already supports the safe values** (hop count via `/^\d+$/`, named proxy, CIDR string — `env.ts:214-231`). The remediation is purely a value/config change plus wiring the standalone path; no new parsing code needed.
- **The standalone `build-redesign-app.ts` path has no env hook at all** — it must be given an explicit argument; setting `TRUST_PROXY` alone will not fix it.
- **Same bug class is not present elsewhere:** CORS and gateway admin lockdown do not rely on `request.ip`, so the exposure is scoped to rate limiting + audit logging.

## Fix options

**Option A (recommended) — trust an exact hop count, on both paths.**
Set `trustProxy` to the number of trusted proxies between the internet and the app so `proxy-addr` counts that many hops in from the right and ignores forged left-hand entries.

- Legacy path: change the fallback so it is **not** an open `true`. Prefer failing closed to a safe count, e.g. `trustProxy: config.server.trustProxy ?? 1`, and set `TRUST_PROXY` explicitly in `k8s/base/configmap.yaml` / overlays to the verified hop count for the Istio topology.
- Standalone path (`build-redesign-app.ts:152`): thread a value in via `deps` (e.g. `deps.trustProxy`) and pass it instead of the literal `true`; default it to the same safe count.
- Determine the exact count empirically (log `request.ips` behind the real gateway). Behind the Istio ingress gateway this is typically `1`; add one per additional L7 hop (external LB, CDN). **Belt-and-braces:** also set Istio `meshConfig.gatewayTopology.numTrustedProxies` so the gateway itself sanitizes inbound XFF, then keep the small Fastify hop count.

**Option B — trust a CIDR / named preset instead of a count.**
Pass the trusted proxy network (e.g. the pod/mesh CIDR or `'uniquelocal'`) so only addresses from that range are trusted. More robust to topology changes than a raw count but requires knowing the mesh CIDR. `parseTrustProxy` already accepts a CIDR string.

**Do not** leave `true` on either path. **Add a test** (integration, via `app.inject`) asserting that with a configured hop count a request carrying `X-Forwarded-For: 1.2.3.4` resolves `request.ip` to the socket/edge address, not `1.2.3.4`, to pin the fix.

## Related

- [H3](H3-...md) — unthrottled/underthrottled public MCP; H4 makes even the present MCP throttle bypassable (the two compound).
- Main report: rate-limit / abuse-control section.
