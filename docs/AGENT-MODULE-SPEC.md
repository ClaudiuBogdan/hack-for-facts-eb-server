# Agent Module Spec — In-App AI Agent over the Shared Kernel

Status: **approved design, v1 scaffolded** (2026-07-06)
Owners: server `src/modules/agent/`, client `hack-for-facts-eb-client/src/features/agent/`

The AI agent layer lets authenticated Transparenta.eu users chat with an agent that
answers strictly from our own data (budget execution, entities, parliament, legal,
procurement, PNRR, judicial, companies), generates deep links / short links to
charts and maps, and — in later phases — runs long-form research and ships as an
MCP App inside ChatGPT and Claude.

Built on **AI SDK 7** (`ai@^7`, [ai-sdk.dev](https://ai-sdk.dev)) with multiple
providers behind a model router (Anthropic, OpenAI, OpenRouter).

---

## 0. Decision record

| Decision     | Choice                                                                 | Rationale                                                                                       |
| ------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Client       | TanStack Start app, new `/agent` route                                 | existing app, Clerk already wired                                                               |
| Providers    | Anthropic + OpenAI + OpenRouter, tiered routing                        | cost/quality routing, no gateway lock-in                                                        |
| Access       | Clerk-authenticated users only                                         | hard cost/abuse control                                                                         |
| Scope        | v1 chat+tools+chart links → v2 deep research → v3 MCP Apps             | ship early, design for all three                                                                |
| Tool layer   | **Shared tool registry = the kernel `KernelMcpTool` contract**         | one canonical definition already feeds `/api/v1/mcp`; the agent wraps the same tools in-process |
| Storage      | Postgres (user DB) full history; Redis for quotas + stream state       | history sidebar, resumable threads, anonymization flow reuse                                    |
| Chart output | structured spec part + deep link + short link, inline render on client | best UX; links-only is the degraded path                                                        |
| Transport    | direct Fastify SSE on `/api/v1/agent/*`, resumable                     | no proxy hop; refresh-safe once resume ships                                                    |
| Cost control | daily token budget per user in Redis + admin allowlist                 | bounds agent loops, not just messages                                                           |
| Web search   | not in v1                                                              | grounded answers only                                                                           |

## 1. Architecture overview

```
client (TanStack Start)                     server (Fastify, legacy app w/ REDESIGN_SURFACE_ENABLED)
┌──────────────────────────┐               ┌────────────────────────────────────────────────────┐
│ /agent route             │  POST (SSE)   │ /api/v1/agent/chat        ── agent REST routes     │
│  useChat (@ai-sdk/react) ├──────────────►│   Clerk preHandler (strict)                        │
│  DefaultChatTransport    │◄──────────────┤   quota check (Redis)                              │
│  + Clerk Bearer fetch    │  UIMessage    │   streamText({ model: router(tier),                │
│                          │  chunks       │     tools: kernelToolsToAiTools(moduleMcpTools) }) │
│ renders message.parts:   │               │   persist UIMessages → user DB                     │
│  text / tool cards /     │               │                                                    │
│  chart spec inline       │               │ shared kernel (Kysely<ProdDatabase>)               │
│  + deep/short links      │               │   modules: budget, parliament, legal, …            │
└──────────────────────────┘               │   moduleMcpTools: KernelMcpTool[]  ◄─ SAME tools   │
                                           │      ├──► /api/v1/mcp (ChatGPT/Claude, v3 Apps)    │
                                           │      └──► agent ToolSet (in-process)               │
                                           │                                                    │
                                           │ user DB (Kysely<UserDatabase>): AgentConversations │
                                           │ Redis: quota counters, stream resume state         │
                                           └────────────────────────────────────────────────────┘
```

Key property: **the agent and the external MCP surface consume the identical tool
definitions** (`KernelMcpTool`: Zod raw shape + handler + `{ok, kind, link, item(s),
meta, summary}` envelope). Adding a tool to any kernel module makes it available to
the in-app agent, to Claude/ChatGPT via `/api/v1/mcp`, and later to MCP Apps — with
zero duplication.

## 2. Server module — `src/modules/agent/`

Standard core/shell layout. The module is NOT a data-source module (no
`graphqlSlice`/`contributor`); it is a service module registered on the redesign
surface with extra deps from the legacy app.

```
src/modules/agent/
├── core/
│   ├── types.ts        # ConversationId, AgentConversation, StoredUiMessage, quota types
│   ├── errors.ts       # AgentError union (+ HTTP status map)
│   ├── ports.ts        # ConversationRepo, QuotaStore
│   └── usecases/
│       ├── prepare-chat.ts        # ownership + quota gate before any LLM call
│       ├── record-usage.ts        # post-step token accounting
│       └── conversations.ts       # list / get / delete (ownership-scoped)
├── shell/
│   ├── repo/conversation-repo.ts  # Kysely<UserDatabase>
│   ├── quota/redis-quota-store.ts # daily token counters (ioredis)
│   ├── llm/model-router.ts        # tier → LanguageModel (anthropic/openai/openrouter)
│   ├── tools/kernel-tools.ts      # KernelMcpTool[] → AI SDK ToolSet
│   ├── prompts/system-prompt.ts   # grounding + linking + refusal rules
│   └── rest/routes.ts             # Fastify plugin (auth preHandler + endpoints)
└── index.ts                       # makeAgentModule(deps)
```

### 2.1 Dependency wiring

`makeAgentModule` deps (all injected by the composition root):

- `tools: readonly KernelMcpTool[]` — the collected `moduleMcpTools` from
  `registerRedesignSurface` (plus kernel tools).
- `userDb: Kysely<UserDatabase>` — conversation storage.
- `redis: Redis` — quota counters (+ stream resume state, v1.1).
- `authProvider: AuthProvider` — the legacy Clerk adapter (cached).
- `config: AgentConfig` — models, budget, allowlist, clientBaseUrl.
- `logger` — Fastify logger.

Registration: `BuildRedesignAppDeps` gains an optional `agent?: AgentSurfaceDeps`
block. `registerRedesignSurface` builds the module AFTER collecting
`moduleMcpTools` and registers its REST routes on the same scope. The standalone
redesign server (`redesign-api.ts`) does not pass `agent` → surface absent. The
legacy mount (`build-app.ts`) passes it when `config.agent.enabled`.

Auth bypass: `/api/v1/agent/*` is added to the legacy global-auth exemption
(prefix match) because the agent plugin enforces its own **strict** Clerk
preHandler (`authenticate` → reject anonymous with 401). Nothing on
`/api/v1/agent/*` is reachable without a valid Clerk JWT.

### 2.2 Endpoints

All JSON unless noted. All require `Authorization: Bearer <clerk JWT>`.

| Method   | Path                              | Purpose                                                                                                                                                                                                                                              |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/agent/chat`              | Chat turn. Body: `{ id: conversationId, messages: [newUserMessage] }`; the single message is text-only. The server loads canonical history. Streams **UI message chunks** (SSE, `text/event-stream`) and creates the conversation row on first turn. |
| `GET`    | `/api/v1/agent/conversations`     | List the caller's conversations (id, title, updatedAt), newest first, limit 50.                                                                                                                                                                      |
| `GET`    | `/api/v1/agent/conversations/:id` | Full conversation (stored `UIMessage[]`) — used to hydrate `useChat` when reopening a thread. 404 if not owned.                                                                                                                                      |
| `DELETE` | `/api/v1/agent/conversations/:id` | Delete a conversation + messages. 404 if not owned.                                                                                                                                                                                                  |
| `GET`    | `/api/v1/agent/quota`             | Remaining daily token budget (drives the client's quota banner).                                                                                                                                                                                     |
| `GET`    | `/api/v1/agent/chat/:id/stream`   | **v1.1** — resume an in-flight stream (see §6). 204 when none active.                                                                                                                                                                                |

Error envelope: `{ error: { code, message } }` with codes
`UNAUTHENTICATED` (401), `QUOTA_EXCEEDED` (429), `CONVERSATION_NOT_FOUND` (404),
`VALIDATION` (400), `PROVIDER_ERROR` (502). In-stream failures surface as the AI
SDK error part with a **generic** message (provider errors are logged, never
forwarded raw).

### 2.3 Chat turn lifecycle

1. Strict auth preHandler → `request.auth` (Clerk `userId`).
2. Validate one text-only user turn, then `prepareChat` atomically reserves the
   caller's remaining daily quota in Redis, load-or-creates the conversation, and
   **verifies ownership** — `err(QUOTA_EXCEEDED)` before any provider call. A second
   concurrent turn for the same user cannot reserve the same budget.
3. Persist the new user message immediately (crash-safe).
4. Load history from the ownership-scoped repository and call
   `streamText({ model: router('chat'), system, messages: convertToModelMessages(canonicalMessages), tools, stopWhen: stepCountIs(8), maxOutputTokens: 4096, timeout })`.
   Client-supplied system, assistant, tool, and transcript history is rejected.
5. `pipeUIMessageStreamToResponse(reply.raw, { originalMessages, onFinish })` —
   `onFinish` reconciles the reservation to actual input+output usage, persists the
   full assistant `UIMessage` (all parts: text, tool calls, tool outputs), and
   auto-titles the conversation on first exchange (cheap-tier,
   `maxOutputTokens: 24`). Provider error/abort and socket-close fallbacks reconcile
   completed-step usage if a normal finish callback never arrives. A separate Redis
   reservation marker makes reconciliation idempotent across competing callbacks or
   an ambiguous retry.

### 2.4 Tool adapter — the shared registry in practice

`kernelToolsToAiTools(tools: readonly KernelMcpTool[]): ToolSet`:

```ts
tool({
  description: t.description,
  inputSchema: z.object(t.inputShape), // same Zod raw shape as MCP
  execute: async (args) => t.handler(args), // same handler, same McpToolOutput
});
```

The `McpToolOutput` envelope is already agent-friendly: `summary` for the model,
`meta` for programmatic totals, `link` for deep links, and its leak-audit tests
guarantee no raw PII. Tool outputs stream to the client as typed
`tool-<name>` parts — the client renders `link`/`kind` directly.

Tool-count note: all modules together contribute dozens of tools. v1 passes them
all; if tool-choice quality degrades, add `experimental_activeTools` narrowing by
conversation topic (the router prompt classifies once per turn) — decision
deferred until observed.

### 2.5 Model routing

`model-router.ts` exposes `router(tier: 'chat' | 'title' | 'research'): LanguageModel`.

- Providers instantiated from env keys present: `@ai-sdk/anthropic`,
  `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`.
- Tier → model id comes from env (`AGENT_CHAT_MODEL`, `AGENT_TITLE_MODEL`,
  `AGENT_RESEARCH_MODEL`) in `provider/model` form, e.g.
  `anthropic/claude-sonnet-4-5`, `openrouter/google/gemini-2.5-flash`.
- Defaults are provider-specific. Anthropic retains the Claude defaults; direct
  OpenAI uses GPT-4.1 / GPT-4.1 mini; OpenRouter uses full provider/model paths.
- A missing direct-provider key is an explicit error unless OpenRouter is
  configured and can route the full original model path. A Claude model id is
  never stripped and sent to OpenAI (or vice versa).

### 2.6 Persistence (user DB)

Two tables (PascalCase, matching the schema):

```sql
CREATE TABLE IF NOT EXISTS "AgentConversations" (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,             -- Clerk user id
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ... ON "AgentConversations"(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS "AgentMessages" (
  id              TEXT NOT NULL,          -- UIMessage id (client- or server-generated)
  conversation_id UUID NOT NULL REFERENCES "AgentConversations"(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  parts           JSONB NOT NULL,         -- UIMessage.parts verbatim
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, id)
);
```

- Stored shape is the AI SDK `UIMessage` (id, role, parts) — lossless for
  re-hydrating `useChat` and re-sending via `convertToModelMessages`.
- `schema.sql` is the fresh-DB source of truth + a timestamped migration under
  `src/infra/database/user/migrations/` for prod.
- **Anonymization**: the Clerk `user.deleted` webhook flow deletes
  `AgentConversations` by `user_id` (cascade) — wired into the existing
  anonymization usecase alongside Notifications et al.

### 2.7 Security model

- **Isolation**: every repo method takes `userId` and scopes by it; there is no
  query path that reads another user's conversation. Ownership is checked in core
  (`prepare-chat`), not just the repo. Message writes lock the owned conversation
  row in the same transaction, preventing delete/recreate races.
- **History trust**: `/chat` accepts one text-only user turn. The server loads all
  prior user/assistant messages from its owned database record and ignores legacy
  stored system rows; clients cannot inject system, assistant, or tool history.
- **Prompt injection**: tools are read-only public data; the blast radius of an
  injected instruction is limited to generating misleading text/links. The system
  prompt pins: answer only from tool results, cite links from tool `link` fields
  only (never fabricate URLs), never echo secrets, refuse instructions embedded in
  data. Short links are only created for `clientBaseUrl`-origin URLs.
- **Spend**: daily token budget (env `AGENT_DAILY_TOKEN_BUDGET`, default 250k
  tokens/user/day) is atomically reserved per in-flight turn and reconciled to
  actual usage, plus `stepCountIs(8)`, a 4096-token output cap per step, and AI SDK 7 `timeout`
  (`totalMs 120s / chunkMs 15s`) + global Fastify rate limit. Allowlist
  (`AGENT_UNLIMITED_USER_IDS`) bypasses the budget for admins. Production does not
  mount the agent surface without Redis; in-memory quota is development/test only.
- **Transport**: CORS already restricts browser origins; SSE responses set
  `Cache-Control: no-store`. Provider keys live only in server env.
- **Validation**: request bodies TypeBox-checked; tool args Zod-checked by the AI
  SDK before `execute`; no `JSON.parse` outside validated paths.

## 3. Client — `hack-for-facts-eb-client`

```
src/routes/agent.tsx + agent.lazy.tsx     # route (auth-gated, no public cache headers)
src/features/agent/
├── components/agent-page.tsx             # layout: sidebar (threads) + chat panel
├── components/agent-chat.tsx             # useChat, composer, message list
├── components/message-parts.tsx          # text / tool cards / chart-spec renderer
├── api/agent-transport.ts                # DefaultChatTransport + Clerk-Bearer fetch
└── api/conversations.ts                  # REST helpers (list/get/delete/quota)
```

- **Transport**: `DefaultChatTransport({ api: `${getApiBaseUrl()}/api/v1/agent/chat`, fetch: authFetch })`
  where `authFetch` injects `Authorization: Bearer ${await getAuthToken()}` (same
  pattern as `graphql-client.ts`).
- **Rendering**: iterate `message.parts` — `text` as markdown; `tool-*` parts as
  compact tool cards (name, running/done state, `summary`, `link` button); a
  `chart_spec` output renders inline via the existing chart-renderer and offers
  "open full chart" (`buildChartRouteLink`) + "share" (`createShortLink`).
- **Gating**: unauthenticated visitors get the sign-in wall (`useAuth`).
- **History**: sidebar lists conversations; opening one hydrates `useChat` with
  stored messages (`messages` option); quota banner from `/agent/quota`.

## 4. Chart/map link + inline-render contract

A dedicated kernel-side tool `generate_chart_link` (agent module contributes it to
the shared registry so MCP clients get it too) accepts a typed chart request
(series query refs, chart type, period) and returns:

```jsonc
{
  "ok": true,
  "kind": "chart_spec",
  "link": "https://transparenta.eu/charts/<id>?...", // ChartUrlState deep link
  "item": {
    /* structured chart spec: type, series[], axes, title */
  },
  "summary": "Line chart of ...",
}
```

- The **client** owns `ChartUrlState` encoding today (`src/lib/chart-links.ts`).
  The contract is a shared JSON shape (documented in the client repo,
  `docs/CLIENT-NORMALIZATION-GUIDE.md` companion section): the server emits the
  spec; the client both renders it inline and encodes the deep link. Until the
  URL-state encoder is ported/shared, the tool emits `link` best-effort from the
  same search-param format the client parses (kept in one server file:
  `shell/tools/chart-links.ts`).
- Map links follow the same pattern with `kind: "map_spec"` targeting `/maps/*`
  routes.
- v1 scaffolds the envelope + client placeholder; the full spec-schema is the
  first post-scaffold implementation task.

## 5. Configuration (legacy `env.ts`)

```
AGENT_ENABLED=true                     # gates the whole surface (default false)
ANTHROPIC_API_KEY=...                  # ≥1 provider key required when enabled
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
AGENT_CHAT_MODEL=anthropic/claude-sonnet-4-5
AGENT_TITLE_MODEL=openrouter/google/gemini-2.5-flash
AGENT_RESEARCH_MODEL=anthropic/claude-opus-4-8    # v2
AGENT_DAILY_TOKEN_BUDGET=250000
AGENT_UNLIMITED_USER_IDS=user_abc,user_def
```

Surfaced as `config.agent`. Requires `USER_DATABASE_URL`, `REDIS_URL`, Clerk vars
(all already present in the legacy app), and `REDESIGN_SURFACE_ENABLED=true`.
`REDIS_URL` is mandatory in production; a missing value leaves the agent surface
unmounted instead of silently using process-local counters.

## 6. v1.1 — Resumable streams

- `resumable-stream` (Redis pub/sub) wraps the UI message stream: on turn start,
  store `activeStreamId` on the conversation row; `GET /agent/chat/:id/stream`
  re-attaches by `Last-Event-ID`; clear on finish.
- Client: `useChat({ resume: true })` reconnects after refresh/drop.
- Needs a second dedicated Redis connection (subscriber) — factory from
  `connect-redis.ts`.

## 7. v2 — Deep research

- `WorkflowAgent` (`@ai-sdk/workflow`) or a BullMQ job wrapping a `ToolLoopAgent`
  with the same shared ToolSet, research-tier model, higher step budget, and
  provider web-search tool enabled.
- New tables `AgentResearchRuns` (status, plan, findings, token spend) + progress
  events streamed to the conversation via the resumable stream; results become an
  assistant message with a report artifact part.
- Budget: research runs draw from a separate, larger per-run token cap with
  explicit user confirmation ("this run may use ~N tokens").

## 8. v3 — MCP Apps (ChatGPT / Claude distribution)

- The tool layer is already shared, so distribution is packaging: extend
  `/api/v1/mcp` with MCP Apps metadata — `_meta.ui` resources rendering chart/map
  iframes (the client's public chart/map routes already embed by URL).
- Auth for external clients: OAuth 2.1 dynamic client registration bridging to
  Clerk (MCP spec auth) — replaces the current `MCP_API_KEY` for user-scoped
  access; anonymous read-only tools can stay keyless.
- `experimental_MCPAppRenderer` is the AI SDK client-side counterpart if we ever
  host third-party MCP apps in OUR chat UI (not planned).

## 9. Testing

- **Unit**: usecases with in-memory fakes (ConversationRepo, QuotaStore) — quota
  boundaries, ownership denial, message persistence ordering.
- **Integration**: `app.inject` against the agent plugin with a
  `MockLanguageModelV2`/`simulateReadableStream` (AI SDK test helpers), fake auth
  provider — asserts SSE framing, 401/429 paths, persistence side effects.
- **E2E**: Testcontainers user DB — conversation CRUD + cascade delete +
  anonymization hook.
- **Leak audit**: agent tool surface reuses the existing MCP leak-audit tests by
  construction (same tools).

## 10. Rollout

1. Scaffold (this change): module + tables + env + client page behind
   `AGENT_ENABLED=false` everywhere.
2. Enable on dev (`AGENT_ENABLED=true`, Anthropic-only), dogfood, tune system
   prompt + tool subset.
3. Add resumable streams (v1.1), quota UX polish, then prod enable for a Clerk
   allowlist cohort before general availability.
