# MCP & Agentic Layer — Architecture Review

**Status:** decision-ready review (no implementation yet)
**Date:** 2026-07-12
**Scope:** `src/modules/mcp/` (legacy), `src/modules/shared/shell/mcp/` + module `shell/mcp/tools.ts` (redesign), `src/modules/agent/`, composition roots, and the execution-line-items onboarding exercise.
**Method:** code-first tracing of the real composition/request/execution paths; docs treated as intent and verified against code; protocol claims checked against the MCP 2025-06-18 spec and the OpenAI Apps SDK docs.

**2026-07-13 procurement remediation amendment:** the legacy `/mcp`
`query_procurement_filters` tool and its MCP-private procurement repository were
removed locally. The historical review and its broader consolidation proposal
remain unchanged; current inventory is six budget tools on `/mcp` and four
procurement tools on `/api/v1/mcp`.

---

## 1. Executive summary

There are **two MCP architectures in the tree**: a legacy, self-contained MCP module with its own duplicate repositories, and a redesign shared-kernel contract that 9 domain modules and the in-process agent already share. The redesign direction is fundamentally sound — **one tool definition (`KernelMcpTool`) already feeds both `/api/v1/mcp` and the agent's AI SDK ToolSet with zero duplication**, and tools call the same core use cases as GraphQL. That is the property to preserve.

What is _not_ production-ready is everything around that contract:

- tool handlers receive **no context** (no caller identity, locale, AbortSignal, deadline, trace id, or surface);
- there is **no tool metadata** (lifecycle, auth requirement, cost class) and **no registry** — exposure is all-or-nothing array concatenation;
- the public MCP endpoint is **unauthenticated and unlimited**;
- the custom stateless transport **precludes resources, prompts, progress, cancellation, and MCP Apps**;
- ~50 of the 53 redesign tools have **no direct tests** and there is **no tool-call observability**;
- the legacy module (~11.8k lines) and the GPT REST surface duplicate capabilities and will drift.

Because the system is pre-production, the recommendation is a **single consolidation pass now**: tool contract v2 (typed input + `ToolContext` + metadata + registry), the official SDK Streamable HTTP transport with a 3-tier auth model, deletion of the legacy MCP module and GPT REST surface, and execution-line-items tools contributed from the legacy mount on the same contract. All five architecture-critical choices below were put to the product owner and are **decided** (§8).

---

## 2. Current architecture — the map

### 2.1 Three stacks, two databases

| Surface         | Path                          | Auth                                                                                    | Transport                                                                                               | Data                                                    | Enabled by                                                                                             |
| --------------- | ----------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Legacy MCP      | `/mcp` (POST/GET/DELETE)      | optional API key (`MCP_AUTH_REQUIRED`, default true)                                    | SDK `StreamableHTTPServerTransport`, real sessions (in-memory or Redis store), SSE via `reply.hijack()` | legacy `budgetDb` via MCP-private adapter repos         | `MCP_ENABLED` (`src/infra/config/env.ts:86`)                                                           |
| Legacy GPT REST | `/api/v1/gpt/*` (6 endpoints) | API key (`GPT_API_KEY`)                                                                 | plain REST + OpenAPI                                                                                    | same MCP adapter repos                                  | registered unconditionally (`src/app/build-app.ts:2643-2668`); fail-closed when `GPT_API_KEY` is unset |
| Redesign MCP    | `/api/v1/mcp` (POST only)     | **none** (path is in the legacy global-auth bypass set, `src/app/build-app.ts:356-358`) | custom stateless JSON-RPC dispatcher, fresh `McpServer` per request                                     | griffin `ProdDatabase` (`transparenta_prod`)            | `REDESIGN_SURFACE_ENABLED` + kernel config                                                             |
| Agent REST      | `/api/v1/agent/*`             | strict Clerk (plugin-owned preHandler)                                                  | Fastify SSE (AI SDK UIMessage stream)                                                                   | griffin tools + user DB (conversations) + Redis (quota) | `AGENT_ENABLED` (requires redesign mount)                                                              |

The **two-database split matters**: the redesign kernel and all its tools run against the griffin `ProdDatabase`; execution-line-items (Forexebug execution data) lives in the legacy `budgetDb` and is reachable today only through legacy GraphQL and the legacy MCP module's private repo. See §6.

### 2.2 Legacy MCP module — `src/modules/mcp/` (~11.8k lines, 36 files)

- 6 tools (`get_entity_snapshot`, `discover_filters`, `rank_entities`, `query_timeseries_data`, `analyze_entity_budget`, `explore_budget_breakdown`), 4 resources (classification guides, glossary, legislation index), 5 prompts (`shell/prompts/prompt-templates.ts`, 1 174 lines).
- Data access is a mix: most tools **reuse canonical module repos through thin adapters** (`shell/adapters/index.ts` bridging entity/UAT/classification/entity-analytics/aggregated-line-items/share). The remaining MCP-owned duplicate is `shell/repo/mcp-execution-repo.ts` (raw-SQL yearly income/expense totals, 10s statement timeout — a query shape not exposed canonically). A third contract remains: dual schema stacks (TypeBox for GPT REST/JSON-Schema, Zod for the MCP SDK) for the same tools.
- Sessions: in-memory transport map + session store with TTL (a Redis store exists but `build-app.ts` wires the in-memory one); rate limiter (in-memory sliding window, 100 req/min) shared with GPT REST; API key checked with `timingSafeEqual`, fail-closed.
- Transport: the **official SDK `StreamableHTTPServerTransport` works under Fastify** here via `reply.hijack()` (`shell/rest/routes.ts:216-218`) — full protocol including GET SSE and DELETE session termination.

**Verdict:** the protocol handling is the most complete in the repo, but the module is an architectural dead end: tools bypass canonical modules, its schemas (TypeBox-based, `core/schemas/tools.ts`) are a third contract, and everything it does well (transport, resources, prompts, rate limiting) belongs in the shared kernel instead.

### 2.3 Redesign shared kernel — `src/modules/shared/shell/mcp/`

The contract (`types.ts:39-44`):

```ts
export interface KernelMcpTool {
  readonly name: string; // `<verb>_<domain>_<noun>`
  readonly description: string;
  readonly inputShape: ZodRawShape; // SDK registerTool requires Zod
  handler(args: Record<string, unknown>): Promise<McpToolOutput>;
}
```

with a uniform output envelope (`types.ts:21-37`): `{ ok, kind, query?, link?, item|items?, meta?, summary?, error? }`, wrapped by `server.ts:14-18` into SDK `{ content, structuredContent, isError }`.

- **53 tools across 10 contributors** (kernel + pnrr, reference, budget, companies, legal, parliament, judicial, procurement, primarii-transparency), all built as `makeXModule().mcpTools` and concatenated in `src/app/build-redesign-app.ts:247-431`.
- Tools call the **same core use cases as GraphQL** (e.g. every procurement tool → `core/usecases.ts`, `src/modules/procurement/shell/mcp/tools.ts:2-3`). No repo duplication on this side.
- Transport: `http-dispatch.ts` builds a **fresh `McpServer` per POST**, feeds one JSON-RPC message through an in-process transport, 30s timeout, notifications → HTTP 202. No sessions, no GET/SSE, no DELETE, no server-initiated messages.
- The dispatcher's header comment claims the SDK transport "routes through `@hono/node-server`" and crashes under Fastify (`socket.destroySoon`). **The legacy module disproves this** — it runs the same SDK transport under the same Fastify version via `reply.hijack()`. The workaround solved an integration problem by amputating protocol capability.
- **Design intent vs code drift** in the redesign's own spec (`docs/server-redesign/00-foundation-shared-kernel.md`): §6.3 specifies TypeBox tool input/output schemas — code uses Zod raw shapes (forced by SDK `registerTool`) with no output validation; §6.3/§8.1 promise rate limiting and an optional `x-api-key` gate on expensive endpoints — neither is applied to `/api/v1/mcp`.

### 2.4 Agent module — `src/modules/agent/`

- `kernelToolsToAiTools` (`shell/tools/kernel-tools.ts`, 26 lines) wraps the _same_ `KernelMcpTool[]` as AI SDK v7 tools — the "define once, consume everywhere" goal already works end-to-end.
- `/api/v1/agent/chat` (`shell/rest/routes.ts`) is the strongest-engineered surface in the layer: strict Clerk preHandler, TypeBox-validated single-user-turn body, server-owned history, **quota reserve/reconcile** with fallback timers, crash-safe user-turn persistence before the provider call, duplicate-message-id rejection, abort on client close, `streamText` bounded by `stepCountIs(8)`, 4 096 output tokens/step, 120s turn timeout, best-effort auto-titling.
- Storage: conversations/messages in the user DB (Clerk-erasure wiring exists); quotas in Redis (in-memory fallback outside prod).
- Gaps: the agent receives **all** tools (no per-agent subset); the tool `execute` ignores the AI SDK's abort signal and options; no user identity/locale reaches handlers; the spec'd v1.1 stream-resume (`GET /chat/:id/stream`) is unbuilt; tool-call telemetry is absent.

### 2.5 Supporting infrastructure worth building on

- **`CollectionFilterSpec`** (`src/modules/shared/core/filters/types.ts`): one declaration derives TypeBox (REST) + GraphQL input SDL + parameterized SQL builders + a canonical filter hash used by cache keys and cursors. _MCP Zod shapes are the one surface not derived from it_ — they are hand-written per tool and can drift.
- **Cursor pagination with filter-hash validation** and `MAX_PAGE_SIZE = 100` (`core/pagination.ts:24`).
- **Structural leak-audit CI tests** (e.g. `tests/unit/judicial/leak-audit.test.ts`) that scan module source — including MCP tool files — for forbidden columns. This pattern generalizes.
- A kernel **rate limiter exists** (30 tokens/60s, `src/modules/shared/index.ts:160`) but guards only the GraphQL `searchEntities` resolver — not MCP.

---

## 3. Answers to the review questions

**Is there one coherent MCP architecture?** No — legacy and redesign implementations overlap, with a third (GPT REST) sharing the legacy adapters. The redesign contract is the keeper; the other two must go (§8, decision 1).

**Is there a reusable MCP core?** Yes, embryonically: `KernelMcpTool` + `McpToolOutput` + the dispatcher + `kernelToolsToAiTools` prove one definition can serve external MCP clients and in-process agents. What's missing is context, metadata, selection, transport completeness, and lifecycle — the v2 contract (§7.1).

**Can a module expose a capability without rebuilding validation/authz/logic/mapping/tests?** Logic and response mapping: yes (tools call core use cases and share the envelope). Validation: half — Zod shapes are hand-written and handlers re-coerce untyped args (`strArg`/`intArg` helpers in every tools.ts) even though the SDK already validated them. Authorization: no story at all. Tests: no shared harness; ~50 tools untested.

**Is the agentic layer isolated/durable/observable/testable/production-safe?** Isolation and cost control are good (Clerk, quotas, bounded loops). Durability is partial (messages persist; streams don't resume). Observability is logs-only, with no tool-call events. Testing covers quota/routing/request-shape units plus an e2e repo test, but not the tool loop.

---

## 4. Strengths to preserve

1. **Single tool definition, two consumers** — the `KernelMcpTool[]` → `/api/v1/mcp` + `kernelToolsToAiTools` wiring. Any redesign must keep this invariant.
2. **Tools call core use cases** — no GraphQL-calling tools, no parallel query implementations on the redesign side.
3. **The output envelope** — `ok/kind/query/link/items/meta/summary` gives models a machine-readable payload _and_ a human summary with caveats (procurement's grain-gate caveats are exemplary), plus client deep links.
4. **The emergent tool-granularity pattern** — `resolve_*` (discovery) → `search_*`/`rank_*`/`aggregate_*` (bounded query) → `get_*` (detail). This should be codified, not reinvented.
5. **Bounded-by-design queries** — selective-filter requirements on huge tables (procurement DA search), topN caps, `MAX_PAGE_SIZE`, cursor-not-count on large sets.
6. **Leak-audit structural tests** and the whitelist discipline in `search_entities` (`shared/shell/mcp/tools.ts:155-178`).
7. **The agent's quota reserve/reconcile pattern** and crash-safe persistence ordering.

## 5. Problems to fix (with evidence)

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                | Evidence                                                                                                                                                                                               | Risk                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Duplicate MCP stacks + GPT REST triplication                                                                                                                                                                                                                                                                                                                           | §2.2; `build-app.ts:2566-2668`                                                                                                                                                                         | drift, triple maintenance, confused security posture                                                                                |
| P2  | No handler context                                                                                                                                                                                                                                                                                                                                                     | `types.ts:43` — `handler(args)` only                                                                                                                                                                   | blocks authz, cancellation, deadlines, tracing, locale; agent runs tools with no principal                                          |
| P3  | Public endpoint unauthenticated + unlimited                                                                                                                                                                                                                                                                                                                            | bypass set `build-app.ts:356-358`; no limiter at `build-redesign-app.ts:433-437`                                                                                                                       | DoS via expensive aggregates; no abuse attribution                                                                                  |
| P4  | Custom transport amputates protocol                                                                                                                                                                                                                                                                                                                                    | `http-dispatch.ts` (POST-only, per-request server) vs spec (single endpoint MUST support POST **and** GET, sessions/SSE/resumability optional but valuable)                                            | no resources/prompts/progress/cancellation; MCP Apps impossible; GET returns 404 (spec wants 405)                                   |
| P5  | No metadata/registry/selection                                                                                                                                                                                                                                                                                                                                         | tools are plain arrays; agent gets everything (`build-redesign-app.ts:449`)                                                                                                                            | can't ship experimental tools, per-surface subsets, or deprecations; flags not fail-closed per tool                                 |
| P6  | Hand-written Zod shapes + untyped handlers                                                                                                                                                                                                                                                                                                                             | every `tools.ts` re-coerces args; `CollectionFilterSpec` doesn't emit Zod                                                                                                                              | schema drift vs GraphQL/REST; boilerplate; silent default-swallowing of bad args                                                    |
| P7  | ~50 tools untested; no tool-call observability; no integration test drives `POST /api/v1/mcp` through the real JSON-RPC path with module tools registered                                                                                                                                                                                                              | only `tests/unit/global-search/mcp-kernel-tools.test.ts` + dispatcher test with a stub server; agent adapter (`kernelToolsToAiTools`), `prepareChat`, and the `/chat` streaming loop are also untested | regressions invisible; no latency/error/usage data to tune descriptions                                                             |
| P8  | Budget-execution querying exists in **three parallel implementations**: canonical `execution-line-items` (AnalyticsFilter ~30 fields, `budgetDb`, GraphQL-only), legacy MCP's raw-SQL `mcp-execution-repo.ts` (`budgetDb`), and the redesign budget module's `CollectionFilterSpec` over the griffin snapshot `budget.execution_line_items` (`budget/core/filters.ts`) | §6                                                                                                                                                                                                     | drift across three filter vocabularies; the agent sees only the budget-module reimplementation, not the canonical line-item surface |
| P9  | 30s hard dispatch timeout, no per-tool budget; DB statement timeouts inconsistent                                                                                                                                                                                                                                                                                      | `http-dispatch.ts:132`; legacy repo sets 10s, kernel repos vary                                                                                                                                        | slow aggregates hold connections; one tool can consume the whole request budget                                                     |
| P10 | Housekeeping: root-level `tmp-*.ts` debris (`tmp-mcp-debug2.ts`, `tmp-kernel-smoke.ts`, …)                                                                                                                                                                                                                                                                             | repo root                                                                                                                                                                                              | noise; some bypass the composition root                                                                                             |

---

## 6. Onboarding exercise — execution line items

**Today** (`src/modules/execution-line-items/`): clean core (`types.ts`, `ports.ts`, `errors.ts`, use cases `list-execution-line-items.ts` / `get-execution-line-item.ts`), a Kysely repo on `budgetDb`, and a GraphQL shell. ~2.2k lines. Its filter model is the richest in the repo (~30 fields with a parallel `exclude` negation object, aliasing the shared `AnalyticsFilter`) and its repo is the performance reference (index-prefix-ordered stages, conditional joins, `COUNT(*) OVER()`, 30s statement timeout) — the parliament/procurement filtering brief explicitly names it the gold standard.

**The three-implementations problem (P8):** budget-execution querying already exists three times — this canonical module, legacy MCP's private `mcp-execution-repo.ts`, and the redesign **budget module**, which re-declares execution filtering as `CollectionFilterSpec`s over the griffin snapshot table `budget.execution_line_items` and whose 5 MCP tools (`resolve_budget_filter`, `get_budget_entity_snapshot`, `rank_budget_entities`, `aggregate_budget_by_classification`, `get_budget_timeseries`) are what the agent sees today. Deleting the legacy repo (D1) removes one path; the remaining two split cleanly by granularity: the budget module owns **aggregates/rankings/timeseries** on griffin, the ELI module owns **line-item-level search/detail** on `budgetDb`.

**What exposing MCP tools requires under the current contract:** write a `shell/mcp/tools.ts` with hand-rolled Zod shapes mirroring the GraphQL filter input, manual arg re-coercion, no auth/context, and — critically — **there is no path to contribute the tools**: the module is wired only in `build-app.ts` (legacy), and the legacy mount passes no `mcpTools` to `registerRedesignSurface` even though the hook exists (`build-redesign-app.ts:69`). The legacy MCP module "solved" this with a private raw-SQL repo (`mcp-execution-repo.ts`) — exactly the duplication this review exists to end.

**Decided path (§8, decision 4):** build ELI tools _inside the ELI module_ on the kernel contract, calling its use cases, and pass them at legacy-mount time through `deps.mcpTools`. The tools then appear on `/api/v1/mcp` and in the agent ToolSet automatically, and migrate unchanged when the data lands in griffin (tools are DB-agnostic by construction — only repo wiring moves).

Two concrete gaps to close on the way:

- **Plumbing:** `build-app.ts:1197` doesn't forward `mcpTools` to `registerRedesignSurface` even though `BuildRedesignAppDeps` accepts it — a one-line pass-through.
- **Ports:** `execution-line-items/core/ports.ts` has only `findById`/`list` — enough for the line-item tools below. Aggregate tools (snapshot, timeseries, breakdown, rankings) are **not** rebuilt here: the redesign budget module already owns them on griffin. If griffin's execution data is not ready at launch and legacy-DB aggregates are still needed, port the `mcp-execution-repo.ts` queries behind an ELI `ExecutionAggregatesRepository` port with `lifecycle: 'internal'` tools explicitly marked for retirement at griffin parity — do not ship two public aggregate vocabularies.

**Recommended tool set** (v2 contract, all `authLevel: 'none'`, `lifecycle: 'public'`, read-only):

| Tool                          | Backing                                                                             | Bounds                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve_execution_filter`    | classification/report-type/period discovery (kernel `resolve_entity` handles names) | cheap; limit ≤ 50                                                                                                                                                    |
| `search_execution_line_items` | existing `listExecutionLineItems` use case                                          | **selective filter required** (entity CUI, or classification + bounded period) — same rule as procurement DA search; cursor pagination; standard cost; `maxItems` 50 |
| `get_execution_line_item`     | existing `getExecutionLineItem` use case                                            | cheap; by id                                                                                                                                                         |

Aggregate questions ("top spenders", "timeseries", "breakdown") route to the budget module's existing tools; the ELI tools' descriptions should say so explicitly so models chain them instead of paging line items.

Not every GraphQL field becomes a tool: the GraphQL surface's full filter combinatorics (~30 fields) stay on GraphQL; the tools expose the question shapes a model actually asks (find → list → detail), each with a mandatory selectivity rule. This exercise is the template for onboarding any module.

---

## 7. Target architecture

### 7.1 Tool contract v2 (decided)

New home: `src/modules/shared/shell/tools/` — tools are surface-neutral; MCP is one consumer, the agent another. Zod stays in shell (core's dependency allowlist is untouched).

```ts
export type ToolCaller =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'user'; readonly userId: string; readonly roles: readonly string[] } // Clerk OAuth
  | { readonly kind: 'agent'; readonly userId: string; readonly conversationId: string } // in-process agent
  | { readonly kind: 'service'; readonly serviceId: string }; // API key

export type ToolSurface = 'mcp' | 'agent' | 'rest'; // 'mcp-app' reserved
export type ToolLifecycle = 'experimental' | 'internal' | 'public' | 'deprecated';
export type ToolAuthLevel = 'none' | 'service' | 'user';
export type ToolCostClass = 'cheap' | 'standard' | 'expensive'; // → deadline + rate buckets

export interface ToolContext {
  readonly caller: ToolCaller;
  readonly surface: ToolSurface;
  readonly locale: 'ro' | 'en';
  readonly signal: AbortSignal; // MCP: SDK RequestHandlerExtra.signal; agent: AI SDK abortSignal
  readonly deadlineMs: number; // absolute epoch ms; repos derive statement_timeout from remaining budget
  readonly requestId: string;
  readonly log: Logger; // pino child bound to { tool, requestId, caller.kind }
}

export interface ToolMeta {
  readonly lifecycle: ToolLifecycle; // default 'experimental'; only 'public' ships to anonymous MCP
  readonly authLevel: ToolAuthLevel; // minimum caller privilege; below → hidden AND rejected
  readonly cost: ToolCostClass;
  readonly maxItems?: number; // result cap, enforced by the wrapper (truncate + meta.truncated)
  readonly outputShape?: ZodRawShape; // → MCP outputSchema/structuredContent (top tools only)
  readonly ui?: McpAppUiMeta; // MCP Apps template resource URI etc. (phase 3)
  readonly deprecation?: { readonly since: string; readonly replacement?: string };
}

export interface KernelTool<S extends ZodRawShape = ZodRawShape, T = unknown> {
  readonly name: string; // `<verb>_<domain>_<noun>`, stable forever
  readonly description: string;
  readonly inputShape: S;
  readonly meta: ToolMeta;
  handler(input: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<McpToolOutput<T>>;
}

/** Preserves per-tool inference, erases to the wide type for registry storage. */
export const defineTool = <S extends ZodRawShape, T>(t: KernelTool<S, T>): KernelTool =>
  t as unknown as KernelTool;
```

Notes:

- **Typed input** kills the `strArg`/`intArg` boilerplate: both consumers already validate against the Zod object (MCP SDK `registerTool`; agent bridge `z.object(inputShape)`), so the handler can safely receive the inferred type.
- **`McpToolOutput` envelope stays** — it works well for models and the leak audit. One change: `error?: string` → `error?: { code, message, retryable? }`.
- **Errors:** domain failures keep returning `{ ok: false, error }` (→ `isError` tool result, visible/recoverable for the model); protocol failures (unknown tool, schema, auth denied, rate limit, deadline) are JSON-RPC errors; unexpected throws are caught by the wrapper, logged with `requestId`, and surfaced as a generic internal protocol error — internals never reach the model.
- `KernelMcpTool` remains a deprecated alias for one migration commit; the codemod is mechanical (wrap in `defineTool`, add `meta`, type the args, delete coercion helpers).
- Where a tool's filter mirrors a `CollectionFilterSpec`, add a `toZodShape(spec, fields)` deriver (in `shared/shell/tools/derive-zod.ts`, consuming the core spec) alongside `toTypeBox`/`toGraphQLInput`/SQL builders, and extend the tri-surface equivalence test to quad — this ends the MCP drift (P6). Hand-written shapes remain fine for non-collection args.

### 7.2 Registry and selection (decided)

A real `ToolRegistry` in the shared kernel replaces array concatenation:

- `register(tools, source)` — **throws at boot** on duplicate names and on allowlist entries naming non-existent tools (typos break CI, not prod); validates the naming convention.
- `select({ surface, caller, lifecycles?, allowlist? })` — returns the visible subset. **Fail closed**: missing metadata, unknown flags, or `lifecycle: 'experimental'` exclude a tool from public surfaces; `internal` tools appear only to the in-process agent; `deprecated` tools still execute but are annotated and logged; flag-disabled tools are absent from `tools/list` **and** rejected at `tools/call` (a cached list can't bypass the kill switch).
- An **instrumentation wrapper is applied once inside `register()`** — never per-tool: flag check → `authLevel` re-check (defense-in-depth behind `select()`) → per-caller rate consume → deadline from `meta.cost` (cheap 5s / standard 15s / expensive 30s; tighter for anonymous) → handler → `maxItems` truncation → structured log + metrics (§7.5). No tool author can forget it.
- Modules keep contributing via `makeXModule().mcpTools`; the composition root replaces the `moduleMcpTools.push(...)` block (`build-redesign-app.ts:249-431`) with `registry.register(x.mcpTools, 'x')`. The existing `deps.mcpTools` hook (line 69) remains the external seam for legacy-mounted contributions (ELI).
- Per-agent allowlists become `select({ surface: 'agent', caller, lifecycles: ['public','internal'], allowlist: agentConfig.tools })` — day one a single default profile keeps behavior unchanged until a second agent exists. The agent bridge gains a ctx factory so `execute` forwards the AI SDK `abortSignal` and the real `{ kind: 'agent', userId, conversationId }` caller — fixing both the ignored signal and the missing identity.

### 7.3 Transport and auth (decided)

Adopt the official SDK `StreamableHTTPServerTransport`, reusing the proven legacy `reply.hijack()` integration (delete the hono-crash workaround; the legacy code is the counterexample — the crash comes from writing to Fastify's managed reply _without_ hijacking). Launch in the SDK's **stateless JSON mode** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`): still a per-request server (the SDK's own stateless idiom; cheap — selection is a filter, registration a loop), but protocol ownership (initialize semantics, version negotiation, batching, GET/DELETE answers, cancellation signals via `RequestHandlerExtra.signal`) moves to the SDK. When MCP Apps or long-running tools arrive, the **same endpoint** flips on `sessionIdGenerator` + a Redis event store (cannibalize the legacy session store) for SSE, resumability, and progress — nothing in the launch design precludes it. Spec conformance targets (2025-06-18): single endpoint answering POST + GET + DELETE correctly, `MCP-Protocol-Version` handling, **Origin validation** (MUST), notifications → 202. Note for tests: `inject()` does not survive `hijack()` + raw writes — MCP integration tests need a small ephemeral-port harness.

Caller resolution happens **before dispatch** (`resolveCaller(req)` — never throws; worst case anonymous), producing the `ToolCaller`, and `/api/v1/mcp` leaves the legacy global-auth bypass set (anonymous becomes an explicit, rate-limited tier, not a hole):

| Tier      | Credential                                                                                 | Tools visible                                     | Limits                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| anonymous | none                                                                                       | `authLevel: 'none'` + `lifecycle: 'public'`       | per-IP ~60/min + daily cap; tight deadlines; `maxItems` caps                                                                    |
| service   | `x-api-key` (hashed, keyed identity; port the legacy key infra before deleting the module) | + `authLevel: 'service'`                          | per-key ~600/min; key id in logs. Not usable for ChatGPT Store / Claude directory distribution — those require no-auth or OAuth |
| user      | OAuth 2.1 Bearer (Clerk)                                                                   | + `authLevel: 'user'` (user-scoped tools, future) | per-user; reuse the agent's Redis quota pattern                                                                                 |

For the OAuth tier: RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource` pointing at Clerk, `WWW-Authenticate` on 401, audience-validated tokens. The ChatGPT Apps SDK runs Authorization-Code + PKCE against your IdP and sends the Bearer token on every tool call, so Clerk slots in directly — with one **spike needed**: confirm Clerk's OAuth-provider feature supports dynamic client registration, or document manual client setup for Claude/ChatGPT connectors.

The in-process agent bypasses HTTP auth but constructs the same `ToolContext` with `caller: { kind: 'agent', userId, conversationId }` from the verified Clerk session, the stream's `AbortSignal`, and `surface: 'agent'` — closing today's confused-deputy gap where tools execute with no notion of who asked. Authorization is decided against `ctx.caller` only, never transport facts; `ToolCaller` values are constructed only at the authenticated entry points, so a forged identity cannot reach a handler. Enforcement is double: `select()` hides over-privileged tools from `tools/list`, and the wrapper re-checks `authLevel` at call time.

### 7.4 Resources, prompts, MCP Apps

- Port the legacy **resources** (classification guides, glossary, legislation index) and **prompts** to the kernel server — content is static and survives the module deletion; they make the public server far more useful to Claude/ChatGPT users.
- **MCP Apps (phase 3):** the SDK-transport + registry design carries it: UI template resources registered per tool via `meta.ui`, structured tool outputs already exist (`structuredContent`), OAuth tier already planned. No architectural rework anticipated — that is the point of doing transport + contract now.

### 7.5 Production-safety and observability

- **Per-tool budgets:** `meta.cost` maps to a handler deadline (cheap 5s / standard 15s / expensive 30s; tighter for anonymous) enforced via `ctx.signal`/`ctx.deadlineMs` + repo statement timeouts derived from the remaining budget (generalize the legacy `setStatementTimeout` discipline to kernel repos).
- **Structured tool-call events:** one log line + Prometheus histogram per call — `{ tool, surface, caller.kind, requestId, durationMs, ok, errorCode, argsHash, itemCount }` (args hashed via `canonicalizeFilters` for spec-derived inputs — raw args never logged). Emitted by the registry wrapper so no tool author can forget it. This also feeds description/eval tuning.
- **Testing expectations:** (a) a shared harness asserting every registered tool has valid metadata + parseable schema + name convention; (b) per-module tool unit tests over the same fakes the use cases use (the untested-50 debt); (c) extend leak-audit style structural tests to new modules with sensitive columns; (d) golden tool-call transcripts later, once real traffic shows the top tools.

---

## 8. Decisions (made by the product owner via interactive review)

| #   | Decision              | Choice                                                                                                                                                                                                           |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Legacy MCP + GPT REST | **Delete both pre-launch.** Port yearly-execution-snapshot capability, resources, and prompts onto the kernel contract backed by canonical use cases.                                                            |
| D2  | Public-surface auth   | **3-tier: anonymous (rate-limited) + API key (partners/own apps) + OAuth 2.1 via Clerk (user-scoped, store apps).** Tool `authLevel` picks the minimum tier; below-tier tools are invisible and uncallable.      |
| D3  | Tool contract         | **Full v2 now** — typed `handler(input, ctx)`, `ToolContext`, lifecycle/auth/cost metadata, real registry with per-surface/per-agent selection. One mechanical breaking pass across ~53 tools while it is cheap. |
| D4  | Execution line items  | **Contribute from the legacy mount** — tools live in the ELI module on the kernel contract, injected via `registerRedesignSurface({ mcpTools })`; unchanged when data migrates to griffin.                       |
| D5  | Transport             | **Adopt SDK `StreamableHTTPServerTransport` now** (sessions + SSE), reusing the legacy hijack() pattern; no post-launch transport break.                                                                         |

### Open items (provisional assumptions — not settled decisions)

- **Write tools:** none pre-launch; assume read-only until a concrete write capability appears, then it gets `authLevel: 'user'` + explicit approval design.
- **Tool versioning:** name-stable additive evolution + lifecycle states (`deprecated` with a `replacement` pointer); no `_v2` suffixes unless semantics change incompatibly.
- **Durable agent runs / stream resume:** defer to agent v1.1 as spec'd (Redis stream state); not blocking launch.
- **Per-agent profiles:** registry supports them from day one; only the single default profile ships until a second agent/experience exists.
- **Anonymous rate-limit numbers:** proposed 60/min + 2 000/day per IP, stricter buckets for `expensive`; tune from tool-call telemetry.
- **Public tool curation:** which of the 53 tools are `lifecycle: 'public'` on the anonymous surface (likely ~25) is a product call. Default for the migration codemod: currently-exposed tools start `public`, demote in review.
- **Clerk-as-OAuth-authorization-server spike:** dynamic client registration support vs manual connector setup — needed before the OAuth tier ships (migration step 9 only).
- **Endpoint path cutover:** `/mcp` as canonical with `/api/v1/mcp` alias during migration; retire the alias once external connector configs are updated.
- **Griffin execution-data readiness:** determines whether interim legacy-DB aggregate tools are needed at all (§6). If the budget module's griffin snapshot is production-ready at launch, skip them entirely.

---

## 9. Migration sequence

Ordered so each step is independently shippable and the tree is never broken:

1. **Close the hole (immediate, independent):** per-IP rate limiting + explicit anonymous handling + body limits on `/api/v1/mcp`; remove it from the legacy global-auth bypass set. Route-level only, no contract changes — can land today.
2. **Contract v2 + registry + instrumentation wrapper** in `src/modules/shared/shell/tools/` (types, `defineTool`, registry with boot-time validation, wrapper with deadlines/caps/logging). Add the tool-metadata test harness.
3. **Mechanical migration of the 53 module tools + 3 kernel tools** to typed handlers + metadata (module by module; behavior-neutral; delete the coercion helpers). Replace the composition-root push-block with `registry.register(...)`.
4. **Transport swap:** SDK `StreamableHTTPServerTransport` in stateless JSON mode via `reply.hijack()` (lift the pattern from legacy `/mcp` while it's still in-tree); delete `http-dispatch.ts`; add the ephemeral-port MCP test harness; Origin validation.
5. **Schema + agent:** `toZodShape` deriver + quad-equivalence test for filter-mirroring tools; agent selection via `registry.select`, ctx factory wiring AbortSignal + caller identity + locale into `execute`; tool-call events flowing.
6. **API-key tier:** port the legacy key verification into `resolveCaller` (before the legacy module is deleted).
7. **ELI workstream:** `shell/mcp/tools.ts` (resolve/search/get per §6, reusing existing use cases) + the `mcpTools` pass-through in `build-app.ts`; port legacy resources + prompts onto the kernel server (reference dictionaries become resources, not tools — shrinking the public tool count). Legacy-DB aggregate tools only if griffin execution data isn't ready, marked `internal` + retired at parity.
8. **Delete legacy:** `src/modules/mcp/` (~11.8k lines), GPT REST routes, config keys (`MCP_ENABLED`, `MCP_AUTH_REQUIRED`, `GPT_API_KEY`, session TTLs), their tests, and the root `tmp-*.ts` debris.
9. **Clerk OAuth tier:** protected-resource metadata + token verification, after the Clerk spike (nothing blocks on it).
10. **Polish (continuous):** `outputShape` on the top ~10 tools, per-module tool unit tests (pay down the untested-50 debt), eval harness v1 in `tests/evals/` (nightly task prompts → agent run → assert tool selection + envelope facts; the gate for adding orchestration tools).

Steps 2–4 are the critical path; 1 lands immediately; 6–8 are one workstream; 9 is independent.

---

## 10. Validation & security expectations

- **Fail-closed everywhere:** unknown flags, missing metadata, unresolved tiers, and disabled modules all _remove_ tools rather than defaulting them in.
- **DoS bounds:** every list/aggregate tool declares selectivity rules + caps; per-cost-class rate buckets; per-tool timeouts; DB statement timeouts.
- **Leak discipline:** extend the structural leak-audit pattern to every module with sensitive columns; keep the `search_entities` attrs-whitelist approach for any raw-search-hit exposure.
- **Confused deputy:** the agent executes tools as the _user's_ principal (D2/D3 wiring), never as an ambient service identity; MCP OAuth tokens are audience-validated and never passed through to upstream services.
- **Injection boundaries:** tool summaries/descriptions are server-authored; tool outputs carry data, not instructions; treat any future user-authored content in outputs as untrusted (label in `meta`).
- **Spec conformance checks:** GET must return SSE or 405 (never 404); notifications → 202; `Mcp-Session-Id` semantics; Origin validation. Add an integration test against the new endpoint asserting these.

## 11. References

- MCP spec 2025-06-18 — transports (Streamable HTTP requirements, sessions, resumability) and authorization (OAuth 2.1, RFC 9728 discovery, audience binding): modelcontextprotocol.io/specification/2025-06-18.
- OpenAI Apps SDK — MCP server + UI resources + OAuth/PKCE requirements for ChatGPT apps: developers.openai.com/apps-sdk.
- Repo docs verified against code: `docs/AGENT-MODULE-SPEC.md` (matches implementation; v1.1 resume unbuilt), `docs/MCP-MODULE-SPEC.md` (describes the legacy module slated for deletion), and `docs/MCP-PROMPTS.md`.
