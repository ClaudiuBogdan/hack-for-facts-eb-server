# 00 — Foundation & Shared Kernel (binding contract)

> **Status:** binding. Every per-source module plan (`01..12`) MUST conform to
> the contracts in this document. Where a source needs to deviate, it states so
> explicitly in its plan with rationale.
>
> **Scope:** the from-scratch redesign of the server's data-source modules on the
> `dev` branch, served from the production database `transparenta_prod` (griffin,
> `transparenta-eu-etl-prod`). It supersedes the monolithic `unified` exploration
> module (preserved on `feat/unified-explorer`) with **one module per data source
> over a shared kernel**, each exposing **REST + GraphQL + MCP**.

---

## 1. Decisions this document fixes (from user, 2026-06-16)

| # | Decision | Choice |
|---|----------|--------|
| F1 | Topology | **Module-per-source + a `shared/` kernel**. No monolithic `unified` module. |
| F2 | API surface | **Full REST + GraphQL + MCP** for every source module. |
| F3 | Scope | One module/plan per data source (12), portal-legislativ + monitorul-oficial co-own the `legal` module but are planned separately and coordinated here (§9). |
| F4 | Source of truth | The live `transparenta_prod` schema (snapshot in `_prod-schema/*.tsv`) + scrapper prod-migrations + `prod-db/*_NOTES.md`. |
| F5 | Read/write posture | The server is **read-only** over the serving DB. No writes, no migrations from the server. Loaders/migrations stay in the scrapper. |

---

## 2. Directory topology

```
src/modules/
  shared/                         # the kernel — owned by no single source
    core/
      ports.ts                    # kernel repo + client interfaces
      types.ts                    # Organization, Territory, MoneyFlow, Document, scalars
      errors.ts                   # ApiError discriminated union + HTTP map
      pagination.ts               # cursor + offset contracts/helpers
      filters/                    # the shared filter DSL (§7)
        types.ts  composer.ts  entity.ts  territory.ts  period.ts
        amount.ts  classification.ts  text.ts  exclusion.ts
      usecases/                   # cross-source: entity-360, global search, ask, compare
    shell/
      db/                         # Kysely instance(s), generated DB types, pool wiring
      repo/                       # identity-repo, territory-repo, flows-repo, search-repo, document-repo
      clients/                    # meili-client, opensearch-client, synthetic-client
      middleware/                 # cache, rate-limiter, auth-bypass, error-handler
      rest/                       # shared REST helpers: envelope, validation, openapi merge
      graphql/                    # root schema, shared scalars, Entity join type, dataloaders
      mcp/                        # MCP server bootstrap, shared tool helpers, registry
    index.ts                      # kernel public API (factories + types)

  <source>/                       # e.g. budget, companies, parliament, legal, pnrr, ...
    core/
      ports.ts                    # source repo interface(s)
      types.ts                    # source domain types (rows + view models)
      usecases/                   # source business logic over ports (neverthrow Result)
    shell/
      repo/                       # Kysely repo(s) over the source's prod schema
      rest/                       # routes + TypeBox schemas (+ openapi fragment)
      graphql/                    # typedefs + resolvers (extend root Query)
      mcp/                        # tool definitions + handlers
    index.ts                      # makeXModule(deps) -> { rest, graphql, mcp, repos }
```

**Rules**

- A source module **never imports another source module**. Cross-source needs go
  through the kernel (identity/flows/search) or are composed in a kernel usecase.
- Source modules depend **only** on `shared/` (the kernel) and infra.
- The kernel **never imports a source module**. Cross-source usecases (entity-360,
  global search, ask, compare) live in `shared/core/usecases` and consume kernel
  repos + a registry of source "contributors" (§4.4), not source modules directly.
- Hexagonal: `core/` is pure (no fastify/kysely/http imports); `shell/` adapts
  core ports to Kysely/Fastify/MCP. Usecases are framework-free and unit-testable
  with mocked ports.

---

## 3. Database & connection contract

- **One serving DB** `transparenta_prod`, **schema-per-domain**. The server is a
  read replica consumer; it issues cross-domain reads as plain SQL joins.
- **One Kysely instance** typed over the full DB (`shared/shell/db`), with a
  generated `ProdDatabase` interface covering all served schemas
  (`core.*`, `flows.*`, `search.*`, `budget.*`, `companies.*`, `parliament.*`,
  `legal.*`, `pnrr.*`, `justice.*`, `procurement.*`, `primarii_transparency.*`).
  **`ngo.*` and `local_politics.*` are forward-looking** — added to `ProdDatabase`
  at promotion time (modules 09, 12); not in the current snapshot, so those modules
  ship feature-flag-disabled until the scrapper lands the schema.
  Source repos receive this typed instance; they only touch their own schema +
  the kernel schemas (`core`, `flows`, `search`).
  - Kysely table keys use the **schema-qualified** name (`'core.organizations'`,
    `'flows.money_flows'`) exactly as the live snapshot in `_prod-schema/`.
- **Pool**: single `pg.Pool` (read-tuned). Defaults: `max` env-driven (10–20 for
  the serving API), `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`,
  `statement_timeout` set per query class (see §5.5). Closed on `app.close()`.
- **No write path.** Repos use `selectFrom`/`with`/raw `sql` for reads only.
  Reject any plan that proposes server-side writes to `transparenta_prod`.
- **Heavy domains** (budget 298 tables incl. range/list partitions; procurement
  17M+ direct_acquisitions) require partition-pruning awareness in every query.
  Column names are **per-table, not uniform** — `budget.execution_line_items`
  prunes on `reporting_year` → `report_type` (→ `account_category` where present);
  `approved_budget_facts` uses `budget_year`; summary MVs use `year`. Every
  flows/procurement scan must be bounded by an indexed predicate. Plans MUST state
  the driving index/partition key for each list/aggregate endpoint, verified
  against the scrapper migration (see §14.8/§14.10 — `_prod-schema/*.tsv` excludes
  partition children).

---

## 4. The shared kernel

### 4.1 Identity hub (`core.organizations`, `core.organization_identifiers`, `core.public_entities`)

Canonical org identity, keyed by normalized CUI. The kernel owns:

```ts
// shared/core/types.ts (grounded in live core.organizations)
export interface Organization {
  readonly orgId: string;            // core.organizations.org_id is BIGINT → string end-to-end (see §14.1); the cross-source link/DataLoader key is CUI, not org_id
  readonly cui: string | null;
  readonly registrationNumber: string | null;
  readonly kind: string;             // 'public_entity' | 'company' | 'ngo' | ...
  readonly name: string;
  readonly normalizedName: string | null;
  readonly countyName: string | null;
  readonly localityName: string | null;
  readonly sirutaCode: number | null;
  readonly firstSeenSource: string;
  readonly attrs: Record<string, unknown>;
}
export interface OrgIdentifier { readonly scheme: string; readonly value: string; readonly source: string; }

export const normalizeCui = (raw: string): string | null => {
  const r = raw.toUpperCase().trim().replace(/^RO/u, '').replace(/[^0-9]/gu, '');
  return r.length > 0 ? r : null;
};
```

Kernel `IdentityRepo` (port): `findByCui`, `findByOrgId`, `getIdentifiers(orgId)`,
`searchByName(q, limit)` (pg_trgm fallback), `resolve(cuiOrName)` →
`{ org, confidence }`. **Every source that has a CUI links to this hub by CUI**
(link-not-merge: never reassign `org_id`s across registries). `core.public_entities`
is the budget-world registry (kept as-is, `default_report_type`, `issues` pattern).

### 4.2 Territory hub (`core.territories`)

SIRUTA-keyed territory anchor: `territorial_siruta_code`, `siruta_code`,
`county_siruta_code`, `uat_code`, `county_code`, `county_name`, `region`,
`population`. Kernel `TerritoryRepo`: `byTerritorialSiruta`, `byCounty`,
`searchUat(q)`, `listCounties()`, `listRegions()`. **All geographic filters across
all sources resolve through this hub** (the `GeographicFilter` family, §7). Source
rows carry `county_name`/`siruta` denormalized; canonical territory metadata
(population, region) comes from the hub.

### 4.3 Money flows (`flows.money_flows`)

The cross-source money graph. Columns (live): `flow_type`, `source_id`,
`source_ref`, `payer_cui/name/org_id`, `payee_cui/name/org_id`, `amount_ron`,
`amount_eur`, `currency`, `flow_date`, `flow_year`, `title`,
`classification_system`, `classification_code`, `county_name`, `attrs`.

Kernel `FlowsRepo` (the **only** repo that reads `flows.money_flows`): flow
summary by CUI+direction, top counterparties, paginated flow list (cursor),
counterparty network (depth-bounded), grouped aggregates (`aggregateFlows`).
Source modules **do not** query `flows.money_flows` directly — they expose their
own native facts (e.g. `budget.execution_line_items`, `procurement.contracts`,
`pnrr.payments`) and rely on the kernel for the unified flow view. `flow_type`
values are owned per source and registered in `shared/core/types.ts`
(`FLOW_TYPES` enum) so the GraphQL/MCP enums stay in sync.

### 4.4 Cross-source aggregation (entity-360, search, ask, compare)

Kernel usecases compose data by CUI across sources via a **source-contributor
registry**:

```ts
export interface SourceContributor {
  readonly source: string;                       // 'budget' | 'companies' | ...
  presenceFor(cui: string): Promise<Result<SourcePresence | null, ApiError>>;
  profileSlice?(cui: string): Promise<Result<EntityProfileSlice | null, ApiError>>;
}

// CANONICAL open shapes (deliberately permissive — retires the old fixed boolean
// record `{ isSupplier, isAuthority, inPnrr, ... }`). Every module's contributor
// fills the common fields + its own `attrs`/`data` payload. See §15.2.
export interface SourcePresence {
  readonly source: string;
  readonly present: boolean;
  readonly label?: string;
  readonly count?: number;
  readonly badges?: readonly string[];
  readonly asOf?: Record<string, string | null>;
  readonly attrs?: Record<string, unknown>;      // per-source open payload
}
export interface EntityProfileSlice {
  readonly source: string;
  readonly kind: string;
  readonly summary?: string;
  readonly data?: Record<string, unknown>;        // per-source open payload
}
```

Each source module **registers a contributor** at wiring time. `makeEntity360`,
`makeGlobalSearch`, `makeCompare`, `makeAsk` iterate the registry — adding a new
source extends entity-360 **without editing the kernel**. This replaces the
hard-coded `Entity360Deps` of the old unified module.

### 4.5 Search (`search.documents` + Meili + OpenSearch [+ pgvector later])

`search.documents` (live): `doc_id`, `doc_type`, `title`, `body`, `cuis text[]`,
`doc_date`, `amount_ron`, `county_name`, `url`, `attrs`, plus
`indexed_meili_at`/`indexed_os_at`/`embedded_at`. Kernel owns the **hybrid search
contract**:

- **Meilisearch** — instant entity-name / prefix autocomplete (`SearchClient.multiSearch`).
- **OpenSearch** — relevance/full-text + terms aggregations.
- **Postgres** — `search.documents` is the rebuildable projection + `ILIKE`/trigram
  fallback when search services are down.
- **Semantic/pgvector** — ⚠ **not live in serving yet** (no vector column on
  `search.documents` in the current snapshot; decision #21 puts pgvector in
  `transparenta_prod` as a future projection). Plans MUST treat semantic search
  as **capability-gated**: degrade gracefully, never hard-depend.

`doc_type` is the per-source discriminator. **Live/planned names (corrected to
prod, see §15.1)**: `legal_act`, `portal_section`, `mo_act` (+ deferred
`mo_section`, `mo_section_metadata`), `procurement_procedure`,
`procurement_contract`, `procurement_direct_acquisition`, `pnrr_entity` /
`pnrr_announcement` / `pnrr_acquisition` / `pnrr_contractor` / `pnrr_measure`,
`parliament_bill_dossier` / `parliament_bill_law_link` / `parliament_control_item`
/ `parliament_speech_segment`, `judicial_case` (privacy-gated),
`primarii_transparency_entity`, and deferred `budget_entity`/`budget_report`,
`company`, `local_politics_council`. There is **no `pnrr_payment` doc_type**
(per-payment docs are excluded by design). Each source plan declares the
`doc_type`s it owns and how its rows project into `search.documents` (the scrapper
`search` lane writes them; the server only reads/queries).

### 4.6 Shared clients & middleware

- `clients/`: `meili-client`, `opensearch-client`, `synthetic-client` (embeddings
  + chat for `ask`). Same interfaces as the old unified module; config via env.
- `middleware/`: in-process `cache` (TTL+LRU, `invalidateByPrefix`), token-bucket
  `rate-limiter` (per-IP, for AI/expensive endpoints), `auth-bypass` (data API is
  public-read; see §8), centralized `error-handler` (maps `ApiError` → HTTP).

---

## 5. Cross-cutting contracts

### 5.1 Error model

```ts
export type ApiError =
  | { type: 'NotFound';            message: string; resource?: string }
  | { type: 'InvalidInput';        message: string; field?: string }
  | { type: 'Database';            message: string; cause?: unknown }
  | { type: 'Upstream';            message: string; service?: string }   // meili/os/synthetic
  | { type: 'ServiceUnavailable';  message: string }
  | { type: 'Timeout';             message: string };

export const HTTP_STATUS: Record<ApiError['type'], number> = {
  NotFound: 404, InvalidInput: 400, Database: 500,
  Upstream: 502, ServiceUnavailable: 503, Timeout: 504,
};
```

- Core/usecases return `Result<T, ApiError>` (**neverthrow**). No throwing for
  expected failures.
- REST maps via `HTTP_STATUS`; GraphQL maps `ApiError` → typed GraphQL errors with
  `extensions.code = type`; MCP returns `{ ok: false, error: type, message }`.

### 5.2 Response envelope (REST)

```jsonc
// success
{ "ok": true, "data": <payload>, "meta"?: { "page": {...} | "cursor": {...} } }
// error
{ "ok": false, "error": "NotFound", "message": "…" }
```

GraphQL returns payloads directly (no `ok` wrapper); errors via the errors array.
MCP returns the structured tool output object (`ok` + `kind` + `item(s)` + `link`).

### 5.3 Pagination

Two shared shapes, **pick per endpoint, declared in the plan**:

- **Offset** (`page`, `pageSize`, default 1/20, max pageSize 100) — for
  bounded/searchable lists where total count is cheap. `meta.page = { page, pageSize, total }`.
- **Cursor** (opaque base64 of the sort key tuple, e.g. `(flow_date, flow_id)`) —
  for large/streamed lists and time-ordered feeds. `meta.cursor = { next: string | null }`.
  Cursors MUST encode the active filter set's hash to reject filter-mismatched cursors.
- GraphQL list fields use **Relay-style connections** (`edges/node/pageInfo`,
  `first/after`) backed by the same cursor encoder for parity with REST.

### 5.4 Sorting & defaults

Every list endpoint declares: default sort, allowed sort keys (enum), default
filters (e.g. budget defaults to latest year). No implicit unbounded scans.

### 5.5 Timeouts, limits, caching

- `statement_timeout`: 5s default reads; 15s for aggregates; 30s for `ask`.
- List `limit`/`pageSize` hard caps stated per endpoint (≤100 rows, ≤500 for flows).
- Cache: read-through on hot GET endpoints, key = `<module>:<op>:<normalized-params>`;
  invalidation is TTL-only (serving DB changes via loader runs, not request path).

---

## 6. API surface conventions

### 6.1 REST

- Prefix **`/api/v1/<domain>/`** (e.g. `/api/v1/budget/`, `/api/v1/companies/`,
  `/api/v1/legal/`). Cross-source kernel routes under **`/api/v1/entities/`**
  (entity-360, compare), **`/api/v1/search`**, **`/api/v1/ask`**.
- TypeBox schemas for **every** query/param/body; validation at the route boundary;
  `Static<typeof Schema>` is the handler input type.
- Each module exports an **OpenAPI fragment**; the kernel merges them into one spec
  at `/api/v1/openapi.json`.
- Resource conventions: `GET /<domain>/<collection>` (list+filter+paginate),
  `GET /<domain>/<collection>/:id` (detail), `GET /<domain>/.../aggregate` or
  `/analytics` (grouped rollups). Mutations: none (read-only API).

### 6.2 GraphQL

- **Schema-stitched federation in-process** (not Apollo Federation): each module
  contributes `typeDefs` (SDL) + `resolvers` that **extend** the root `Query`. The
  kernel owns the base schema, shared scalars, and the join type.
- **Shared scalars** (kernel): `CUI`, `SIRUTA`, `Date` (ISO `YYYY-MM-DD`),
  `DateTime`, `BigInt`, `JSON`, `Money` (RON minor-unit-safe numeric as string).
- **The `Entity` join type** (kernel): an organization addressed by CUI; each
  source contributes fields to `Entity` via type extension (`extend type Entity {
  budget: BudgetEntitySummary, contracts: ProcurementSummary, ... }`) resolved
  lazily through that source's repo + a **DataLoader** keyed by CUI/org_id. This is
  the GraphQL expression of the contributor registry (§4.4).
- Naming: types are **PascalCase, domain-prefixed where ambiguous** (`BudgetReport`,
  `LegalAct`, `MoPublication`, `ProcurementContract`, `PnrrPayment`,
  `JudicialCase`). Enums for `flow_type`, `doc_type`, sort keys, status.
- List fields: Relay connections (`xConnection`, `XEdge`, `pageInfo`) with the same
  cursor as REST. Input filters: one `input XFilter` per collection mirroring the
  REST filter params (§7) — **generated from the same filter spec**.
- Resolvers are **thin**: parse args → call the same core usecase the REST handler
  calls. No business logic in resolvers. DataLoaders prevent N+1 on `Entity` fan-out.

### 6.3 MCP

- Tools live in each module's `shell/mcp/`; registered into the kernel MCP server.
- Pattern (unchanged from current MCP module, kept): TypeBox **input + output**
  schemas; handler calls a core usecase; output is a structured object
  `{ ok, kind, query, link, item|items, summary? }` where `link` is the client deep
  link and `summary` is an LLM-friendly sentence.
- **Two MCP tool families per source** at minimum: (1) a **filter/discovery** tool
  (resolve Romanian names → filter values: CUI, SIRUTA, classification codes,
  status enums) and (2) one or more **query** tools (snapshot/list/aggregate/rank).
  The discovery tool is shared infrastructure (§7.4) parameterized per source.
- Tool naming: `<verb>_<domain>_<noun>` (`get_budget_entity_snapshot`,
  `rank_procurement_suppliers`, `search_legal_acts`). Rate-limited; bounded result
  sizes; never return PII flagged columns (see §8.2).

---

## 7. Filters — the deep spec (priority area)

Filters are the highest-leverage surface (user emphasis) because the **same filter
intent must be expressed identically in REST query params, GraphQL input types, and
MCP tool inputs**, and must compile to **safe, parameterized, partition/index-aware
SQL**. The kernel generalizes the legacy `infra/database/query-filters` design.

### 7.1 The filter pipeline

```
spec (per collection)  ──derives──►  TypeBox schema (REST)  ─┐
        │                                                     ├─► one validated FilterInput object
        ├──derives──►  GraphQL input type ────────────────────┘
        │
        └──compiles──►  ConditionBuilder[]  ──composer──►  parameterized WHERE (Kysely sql``)
```

- A **collection filter spec** is declared **once** per collection (a typed
  descriptor of fields, types, operators, defaults, allowed sort keys). From it we
  derive: the REST TypeBox schema, the GraphQL `input` type, and the MCP tool input
  fragment — so the three surfaces never drift. Plans MUST define this spec for each
  filterable collection.
- Compilation reuses the kernel `composer` (`composeConditions(ctx, ...builders)`)
  and `col(alias, column)` safe column refs. **All user input is parameterized via
  `sql``** — zero string concatenation. (Mirror of the legacy
  `query-filters/composer.ts` + `types.ts`, generalized off the budget aliases.)

### 7.2 Shared filter families (kernel)

Reusable builders every source composes from:

| Family | Fields (examples) | Notes |
|--------|-------------------|-------|
| **Entity** | `cui[]`, `org_id[]`, `kind`, `name~` (trigram) | resolves via identity hub |
| **Territory** | `county_code[]`, `siruta[]`, `region[]`, `is_uat`, `min/maxPopulation` | resolves via territory hub |
| **Period** | `year`, `yearFrom/To`, `dateFrom/To`, `month`, `quarter` | maps to partition keys where present |
| **Amount** | `minAmount`, `maxAmount`, `currency` | numeric(18,2) bounds; overflow-guarded |
| **Classification** | `system`, `code[]`, `codePrefix[]` (functional/economic/CPV/CAEN) | via `core.classification_codes` |
| **Text** | `q` (trigram/Meili/OS depending on endpoint) | declares which engine backs it |
| **Status/Enum** | source-specific enums (e.g. contract status, bill stage) | closed enum, validated |
| **Exclusion** | negation of any of the above (`exclude: {...}`) | symmetric to inclusion |

Source-specific filters extend these (e.g. `procurement.cpv_code[]`,
`legal.act_type[]`, `parliament.chamber`). Source plans must **map each filter
field to its driving column + index/partition** and note cardinality/perf.

### 7.3 Filter ↔ surface mapping rules

- REST: scalar → query param; arrays → repeated param or CSV (declare which);
  ranges → `xFrom`/`xTo`; exclusion → `exclude.x` (bracket) or `notX`.
- GraphQL: one `input XFilter { ... }`; arrays are GraphQL lists; ranges are
  `{ from, to }` input objects; exclusion is a nested `exclude: XFilter`.
- MCP: same fields as REST, plus the discovery tool resolves names → codes first.

### 7.4 Discovery / name-resolution (shared)

Romanian-name → filter-value resolution (entity names → CUI, locality → SIRUTA,
classification label → code, party/court/issuer name → id) is **shared kernel
infrastructure** exposed as the per-source MCP discovery tool and a REST
`/api/v1/<domain>/filters/resolve` helper. Source plans declare which dimensions
they expose for resolution. Driving doc: `prod-db/AI_AGENT_FILTER_QUESTION_CATALOG.md`
— treat it as the **requirements list** for which filters/questions each source must
answer.

---

## 8. Auth, privacy, observability

### 8.1 Auth

The data API is **public-read** (like the old `/api/v1/unified/`): the global auth
validation is bypassed for the new `/api/v1/<domain>/` prefixes. An optional API
key gate (`x-api-key`) protects expensive AI endpoints. No per-user state in data
modules.

### 8.2 Privacy (hard constraint)

- **Judicial (`justice`)**: structural privacy default-deny — **no party-name
  column is exposed**; names only via the publishable-rule-gated dictionary FK
  (per `JUDICIAL_DECISION_REVIEW.md`). The justice module plan must encode this in
  its repo + GraphQL/REST/MCP projections (never select name columns by default).
- **PNRR / procurement**: exclude `*_private` / contact PII tables from all
  surfaces (the old `pnrr.announcement_contacts_private` exclusion).
- Any column the source NOTES mark PII/manual-review is excluded from default
  projections; plans enumerate excluded columns.

### 8.3 Observability

Pino structured logs + OpenTelemetry spans per request (existing infra). Each
module emits per-op metrics (latency, cache hit, upstream errors). `/api/v1/health`
aggregates postgres + meili + opensearch + synthetic statuses.

---

## 9. The `legal` module: portal-legislativ + monitorul-oficial (coordination)

Both sources live in the `legal` schema (14 tables) and **co-own
`src/modules/legal/`**. To plan them separately without divergence, responsibilities
are pre-divided here (binding for plans 05 and 06):

- **portal-legislativ (05)** owns: the legislation/acts surface — `legal.acts` and
  the section/node/full-text + RAG layer; act detail, full-text/semantic retrieval,
  act↔act links, act↔MO links (consumes MO ids). It defines the `legal` module
  **skeleton** (module index, shared legal repo base, `LegalAct` GraphQL type,
  shared legal filter families: `act_type`, `issuer`, `domain`, `year`).
- **monitorul-oficial (06)** owns: the official-gazette surface —
  `legal.mo_issues`, `legal.mo_act_publications`, `legal.mo_lifecycle_edges`,
  status events; publication lookups, issue browsing, lifecycle/status timelines,
  the act↔gazette correlation contract (`mo_part`/`mo_number`/`mo_date`). It
  extends the skeleton 05 defines; it must not redefine the module index or the
  `LegalAct` base type.
- Shared `doc_type`s: portal → `legal_act` + `portal_section`; MO → `mo_act`
  (+ deferred `mo_section`, `mo_section_metadata`). **RECONCILED (see README
  §Reconciliation):** the `legal` module is ONE `makeLegalModule` (portal-owned
  skeleton: module index, `LegalAct` base type, `LegalRepoBase` act mapper, shared
  `act_type`/`issuer`/`domain`/`year` filter families); MO contributes a
  `makeMonitorulSurface` sub-factory composed into it. The module registers
  exactly **one** contributor (`monitorul-oficial`, issuer-slug→org best-effort);
  portal registers none in v1. MO extends `LegalAct` with the gazette field set
  (`publications`, `gazetteStatusEvents`, `gazetteInEdges`) — portal permits this
  multi-field extension (relaxing the earlier "single field" rule).

---

## 10. Wiring & config

- Each module exports `makeXModule(deps): XModule` returning `{ restPlugin,
  graphql: { typeDefs, resolvers }, mcpTools, contributor, repos }`.
- `build-app.ts` builds the kernel (db pool, clients, kernel repos, middleware),
  then constructs each module, then: registers REST plugins, merges GraphQL
  slices into the root schema, registers MCP tools, and registers contributors
  into the kernel registry. Order is data-independent (modules don't depend on
  each other).
- **Config/env** (kernel-owned, namespaced): `PROD_DATABASE_URL` (serving DB),
  `MEILI_HOST`/`MEILI_API_KEY`, `OPENSEARCH_URL`, `SYNTHETIC_BASE_URL`/`_API_KEY`,
  `EMBEDDING_MODEL`/`AI_MODEL`, `API_KEY` (optional gate), pool/limit knobs.
  Validated at boot (TypeBox); module enablement is all-or-nothing on
  `PROD_DATABASE_URL` (individual modules can be feature-flagged off via env list).
- **Coexistence with legacy:** the ~35 legacy GraphQL modules keep running during
  the transition; new modules mount under fresh prefixes/types and do not collide.
  Final cutover is the platform-level #19 transition (server repointed at
  `transparenta_prod`). Plans note any legacy module they supersede.

---

## 11. Testing conventions

- **Unit** (`tests/unit/<module>/`): core usecases with mocked ports; filter spec
  → SQL compilation snapshot tests; cursor encode/decode; mappers.
- **Integration** (`tests/integration/<module>/`): REST + GraphQL + MCP against a
  seeded test DB (or a read-only connection to a fixture schema); contract tests
  that the three surfaces return equivalent data for equivalent filters.
- **Golden filters**: each source ships a table of representative
  questions→filters from `AI_AGENT_FILTER_QUESTION_CATALOG.md` as integration cases.

---

## 12. Binding plan template (every per-source plan MUST follow)

Each `NN-<source>.md` MUST contain these sections, in order. Keep it concrete:
real column names from `_prod-schema/<schema>.tsv`, real endpoint paths, real
filter fields, real GraphQL SDL, real MCP tool signatures.

1. **Summary & data status** — what's in prod now (tables, row counts from NOTES),
   what's deferred, the source's prod schema(s).
2. **Schema → domain model** — table-by-table mapping to module `core/types.ts`
   view models; identity (CUI) + territory (SIRUTA) linkage; PII/excluded columns.
3. **Repo interface (ports)** — the source `Repository` interface(s): every method
   signature, returning `Result<T, ApiError>`; which schema/tables/indexes each hits;
   partition/index notes for heavy queries.
4. **Usecases** — list with signatures; cross-source contributor (`presenceFor`,
   `profileSlice`) and which `flow_type`/`doc_type` it registers.
5. **REST endpoints** — full table: method, path, query/params (TypeBox), response
   shape, pagination kind, cache, statement-timeout class. Include the OpenAPI notes.
6. **GraphQL** — SDL for the source's types, the root `Query` extensions, the
   `Entity` extension fields + DataLoaders, connection types, filter `input`s.
7. **Filters** — the collection filter spec(s): every field → operator → driving
   column/index → REST param ↔ GraphQL input ↔ MCP input; which text engine backs
   `q`; discovery/resolve dimensions; golden question→filter examples from the
   catalog.
8. **MCP tools** — discovery tool + query tool(s): input/output TypeBox, the usecase
   each calls, `link` deep-link format, summary template.
9. **Search integration** — `doc_type`(s) owned, projection into `search.documents`,
   Meili/OS index names, semantic gating.
10. **Sync/freshness impact on serving** — how loader cadence affects cache TTLs and
    any "as-of" semantics the API must surface.
11. **Wiring** — `makeXModule` deps, env additions, build-app registration, legacy
    module(s) superseded.
12. **Testing** — unit + integration + golden-filter cases.
13. **Open questions / risks** — anything needing a user/architecture decision.

> Reviewer sub-agent requirement: before finalizing, each source subagent must have
> a second high-capability agent adversarially review the plan against THIS contract
> (topology, error model, filter pipeline, GraphQL federation, MCP shape, privacy)
> and against the live schema, and must incorporate the findings.

---

## 13. Inputs available to per-source subagents

- Live schema slice: `docs/server-redesign/_prod-schema/<schema>.tsv`
  (`<schema>.<table>\t<column>\t<type>`; budget partition children excluded).
- Scrapper prod migrations: `…/hack-for-facts-eb-scrapper/src/src/db/prod-migrations/`.
- Per-source notes/briefs/research: `…/hack-for-facts-eb-scrapper/prod-db/<SOURCE>_*.md`.
- Filter requirements: `…/hack-for-facts-eb-scrapper/prod-db/AI_AGENT_FILTER_QUESTION_CATALOG.md`.
- Old unified module (reference pattern to improve on, on `feat/unified-explorer`):
  `src/modules/unified/` (companies/parliament/pnrr have repos+routes worth studying).
- Legacy modules (GraphQL + filter DSL prior art): `src/modules/{budget-sector,
  execution-line-items,entity,uat,...}`, `src/infra/database/query-filters/`.

---

## 14. Review-incorporated revisions (BINDING — override §§ above on conflict)

Incorporated from the foundation adversarial review. Where these conflict with an
earlier section, **these win**.

### 14.1 Kernel scalar representation (resolves the bigint trap)

| Scalar | Live column type | TS type | GraphQL scalar | Note |
|--------|------------------|---------|----------------|------|
| `org_id` | `bigint` | `string` | `BigInt` | configure pg int8 parser → string; **never** JS `number` (precision loss > 2^53) |
| `cui` | `text` | `string` | `CUI` | **the cross-source link & DataLoader key** |
| `siruta` | `text` (territories, public_entities) / `integer` (organizations) | `string` | `SIRUTA` | canonicalize to text; cast `core.organizations.siruta_code::text` on join |
| money | `numeric(18,2)` | `string` | `Money` | string to preserve precision; never float |
| date | `date` | `string` (`YYYY-MM-DD`) | `Date` | |
| timestamp | `timestamptz` | `string` (ISO) | `DateTime` | |

DataLoader keys for `Entity` fan-out are **CUI strings**, not `org_id`.

### 14.2 Filter mechanism is kernel-shipped; plans only declare specs (resolves M2)

The kernel implements the filter pipeline once; per-source plans **declare specs
that consume it** — they do NOT invent a DSL. The contract:

```ts
type FilterOp = 'eq'|'in'|'gt'|'gte'|'lt'|'lte'|'between'|'prefix'|'contains'|'isNull';
interface FilterFieldSpec {
  name: string;                              // REST param + GraphQL input field
  type: 'string'|'int'|'number'|'date'|'bool'|'enum';
  ops: readonly FilterOp[];                  // allowed operators for this field
  column: { alias: string; column: string }; // driving column (safe ref, partition/index-aware)
  enumValues?: readonly string[];
  array?: boolean;                            // supports IN / GraphQL list
  exclude?: boolean;                          // may appear under `exclude:` (else not negatable)
  default?: unknown;
}
interface CollectionFilterSpec { collection: string; fields: FilterFieldSpec[]; sort: { default: string; allowed: string[] }; }

// kernel derivers — single source of truth, so the 3 surfaces never drift:
toTypeBox(spec): TSchema                       // REST validation schema
toGraphQLInput(spec): string                   // GraphQL SDL `input` type
toConditionBuilders(spec, input, ctx): ConditionBuilder[]   // → composer → parameterized WHERE
canonicalizeFilters(input): string             // stable key: defaults filled, arrays sorted, lowercased
```

`canonicalizeFilters` output feeds the **cache key, the cursor `fhash`, and the
tri-surface equivalence test** — that single function is what makes REST/GraphQL/MCP
return identical data for identical filters. The §7.2 family table is the menu of
fields; each field now carries an explicit `ops` set. `isNull` is **mandatory**
(catalog presence/coverage questions). Negation applies only to `exclude:true`
fields — there is no universal symmetric negation.

### 14.3 Cursor envelope (replaces §5.3 cursor prose)

```
cursor = base64url( JSON{ v:1, sort:"<key>", dir:"asc|desc", keys:[...sortTuple], fhash:"<hash of canonicalizeFilters(input)>" } )
```

- `fhash` is identical across REST/GraphQL/MCP for the same logical filters.
- On `fhash` mismatch (filters changed mid-pagination): return `InvalidInput`
  (`"cursor/filter mismatch; restart pagination"`; REST 400, GraphQL code
  `INVALID_INPUT`). Clients restart at page 1. Never silently re-apply.
- `v` versions the envelope; bumping it deliberately invalidates in-flight cursors.

### 14.4 Offset pagination guard (amends §5.3)

Offset + `total` is permitted ONLY where the filtered count is cheap (indexed,
bounded). Large sets (procurement, flows) use cursor; any total shown there is
`{ total, estimated: true }` (planner estimate), never a blocking `COUNT(*)`.

### 14.5 Search capability gate (amends §4.5)

Kernel resolves capabilities once at boot, **per domain** (a single global boolean
cannot express the real state: `legal` semantic is LIVE — `legal.document_embeddings`/
`section_embeddings` HNSW exist; `judicial` is policy-forced-OFF even if pgvector
lands, pending a person-leak audit; all other domains are OFF — no vector column on
`search.documents`):

```ts
interface SearchCapabilities { meili: boolean; opensearch: boolean; }
interface DomainSearchCapabilities { semantic: boolean; reason?: string; }  // per domain
// kernel: capabilities.forDomain('legal').semantic === true
```

Semantic fields/endpoints return `null` + `caveats:["semantic search unavailable"]`
when a domain's `semantic=false` — never error. Modules probe their own domain
slot; no per-request gate logic.

### 14.6 Cross-source flow authority — the Grain Gate (amends §4.3, resolves B3)

- `flows.money_flows` (kernel `FlowsRepo`) is authoritative ONLY for the unified
  **entity-360 flow summary / counterparty network / cross-source totals**
  (`/api/v1/entities/:cui/flows`).
- Source-native **top-N / concentration / HHI / same-day-split** answers come from
  the **source's own facts/rollups** (e.g. `procurement.org_edge_monthly_rollups`,
  `procurement.procurement_flow_facts_v1`, `pnrr.payments`), owned by that module.
- **Never mix grains in one answer.** A response that combines `flows.money_flows`
  with a source rollup must label both grains. Each plan declares, per flow
  question, which source is authoritative.

### 14.7 Contributor registry is the single cross-source mechanism (amends §4.4/§6.2)

GraphQL `Entity.<source>` resolvers MUST call the same `contributor.profileSlice(cui)`
usecase that REST entity-360 calls. The registry is the one source of truth;
GraphQL is a projection of it. Required for tri-surface equivalence.

### 14.8 GraphQL namespacing & conflict gate (amends §6.2, resolves M5)

- Every module type/enum is **always** domain-prefixed PascalCase (`Budget*`,
  `Procurement*`, `Legal*`, `Mo*`, `Pnrr*`, `Judicial*`, `Company*`, `Parliament*`).
  No bare generic names (`Document`, `Summary`, `Status`).
- **EXEMPTION (kernel base types):** the prefix rule applies to *module-owned*
  types only. Kernel-owned `shared/core` types are reused un-prefixed by every
  module and must not be re-declared: the scalars (`CUI`, `SIRUTA`, `Money`,
  `Date`, `DateTime`, `BigInt`, `JSON`), the `Entity` join type, `PageInfo`, and
  the kernel object types `Organization`, `Territory`, `MoneyFlow`, `Document`.
  (`LegalAct` is NOT a kernel type — it is portal-owned and `Legal*`-prefixed.)
- A kernel schema-merge **conflict test** runs in CI: building the stitched schema
  must not throw on duplicate type/field. A colliding module fails CI, not boot.

### 14.9 Structural judicial privacy (amends §8.2, resolves M6)

Justice repo row types **structurally exclude** `justice.party_name_keys.display_name`
and `justice.case_hearings.solution_summary` (the row type has no such field).
Publishable names come ONLY from a separate, publishable-rule-gated method. A
dedicated test asserts no REST/GraphQL/MCP surface can emit those columns.

### 14.10 Catalog ↔ live-schema reconciliation (amends §7.4/§13)

`AI_AGENT_FILTER_QUESTION_CATALOG.md` names are **logical**; each subagent
reconciles them to live tables in its plan. Known deltas: `procurement.org_edges`
→ live `procurement.org_edge_monthly_rollups` (monthly grain); `procurement.cpv_codes`
flagged data-quality (verify before relying). **The budget and procurement plans
MUST include a "partition/rollup scheme" subsection** — parent tables, partition
keys, child naming, and the exact pruning predicate each list/aggregate endpoint
uses — verified against the scrapper migration (and `\d+` on griffin if needed,
since `_prod-schema/*.tsv` excludes partition children).

### 14.11 Misc binding (amends §5.1/§5.2/§5.5/§6.1/§8.1/§8.3)

- Error body carries discriminant data + correlation:
  `{ ok:false, error, message, field?, resource?, requestId }`; both envelopes
  include `requestId` (the OTel trace id).
- Cache invalidation: TTL by default **plus** a per-domain loader-completion
  version stamp (read from `etl`/`system_control`) that busts cache and is
  surfaced as the domain's freshness/"as-of" watermark on every read (§12.10). If
  no signal exists yet, TTL-only is the interim — state it explicitly.
- Resource grammar adds `GET /<domain>/<collection>/aggregate` (rollups) and
  `GET /<domain>/filters/resolve?dim=&q=` (name→value); the MCP discovery tool
  wraps the latter.
- Auth: prefer an explicit per-route `config: { public: true }` flag over
  URL-prefix bypass.
- Health vs readiness: `/api/v1/health` (liveness) reports aux services down but
  does **not** fail on meili/opensearch/synthetic being down; `/api/v1/ready`
  gates deploys.

---

## 15. Consistency-pass amendments (BINDING — from the cross-plan review)

Added after the 12 source plans landed. These resolve cross-plan needs; the
authoritative cross-plan **reconciliation log + dependency matrix + scrapper
prerequisites + open user decisions** live in `README.md`.

### 15.1 doc_type names — corrected to prod (see §4.5/§9)
The example set in §4.5 was stale; the corrected canonical `doc_type` list is now
inline in §4.5. Key fixes: MO = `mo_act` (not `mo_publication`); portal section
docs = `portal_section`; **no `pnrr_payment` doc_type** (per-payment docs excluded);
PNRR uses entity/announcement/acquisition/contractor/measure doc_types.

### 15.2 SourcePresence / EntityProfileSlice — canonical open shapes
Now specified inline in §4.4. The old fixed boolean record is retired. Every
contributor returns the common fields + a per-source `attrs`/`data` payload; the
GraphQL `Entity.<source>` resolver MUST call the same `contributor.profileSlice`
(§14.7) so REST and GraphQL stay equivalent.

### 15.3 Kernel `IdentityRepo.territoryForCui(cui)` — NEW kernel method
`TerritoryRepo` (§4.2) is SIRUTA-keyed only, but primarii (11) and wikipedia (12)
carry CUI without SIRUTA. The kernel adds:
```ts
// IdentityRepo (or TerritoryRepo): join core.public_entities.cui →
//   territorial_siruta_code → core.territories
territoryForCui(cui: string): Promise<Result<Territory | null, ApiError>>;
```
Until it ships, the CUI-only modules' `region`/`siruta`/`isUat`/population filters
are capability-gated (return `InvalidInput` with a clear message), not silently
wrong.

### 15.4 `LegalActByIdLoader` — kernel-owned cross-module port
Parliament (04) and judicial (08) resolve `act_id → LegalAct` without importing the
`legal` module (§2 forbids cross-module imports). The **kernel owns the port**; the
`legal` module (05) provides the implementation (its `findActsByIds`) and registers
it. It **must tolerate a dangling `target_act_id`** (legal rebuild reassigns ids;
`mo_act_publications.act_id` is `ON DELETE SET NULL`): return `null` +
`resolutionStatus`, never error.
```ts
interface LegalActByIdLoader { load(actId: string): Promise<LegalAct | null>; loadMany(ids: string[]): Promise<(LegalAct | null)[]>; }
```

### 15.5 Money nullability
`Money` fields are **nullable where the underlying column is nullable** (PNRR
amounts, procurement values, etc.). GraphQL uses `Money` (not `Money!`) on those
fields; a `Money!` resolver would hard-error on the first NULL row.

### 15.6 Array-membership filters
The kernel `toConditionBuilders` (§14.2) compiles **array-typed fields** as
membership, not substring: a `text[]`/jsonb-array column with `contains`/`in`
emits `@> to_jsonb(array[$1])` / array-overlap, NOT a trigram `ILIKE`. Scalar
`contains` stays trigram/ILIKE. (Surfaced by reference `tags` and legal `domains`.)

### 15.7 Unaccent-free, C-locale-safe name folding (kernel standard)
`unaccent` is **NOT installed** in `transparenta_prod`, and `lower()` under the C
locale does not fold `Ş/Ţ/Ă/Î/Â`. The kernel identity search / discovery resolvers
fold diacritics **in TS** (or read a loader-normalized column) — never call
`unaccent()` and never rely on `core.organizations.name` having a trigram index
(it doesn't): name search is Meili-primary with a bounded/capped pg fallback.
