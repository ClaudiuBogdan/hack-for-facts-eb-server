# 01 — Reference module (ins + mfin + public-entities)

> **Status:** plan. Conforms to `00-foundation-shared-kernel.md` (binding). Where
> this plan deviates it says so with rationale. Follows the §12 template (13
> sections, in order).
>
> **One-line scope:** the registry/reference surface over the kernel's `core.*`
> data — public-entity registry browsing/search, territory/UAT lookup,
> classification-code lookup, organization-identity reference. The reference data
> *is largely the shared kernel's data*; this module is the **read surface** over
> it, not a second owner. §0 below fixes the kernel-vs-module boundary that
> governs everything else.

---

## 0. Kernel-vs-module boundary (the special case — read first)

The five `core.*` tables this module touches are **kernel-owned data**. The
foundation contract (§4.1/§4.2) makes the kernel own the *identity hub*,
*territory hub*, and *classification* as cross-source primitives. The reference
module does **not** re-own them. It owns the **registry/reference HTTP+GraphQL+MCP
surface** that lets clients and agents *browse, search, and resolve* that data,
plus the reference-only attributes that no other source cares about
(`default_report_type`, `issues`, `field_trace`, UAT-mapping provenance).

| Concern | Owner | Rationale |
|---|---|---|
| `Organization` type, `normalizeCui`, `IdentityRepo` (`findByCui`, `findByOrgId`, `getIdentifiers`, `searchByName`, `resolve`) | **KERNEL** (`shared/core` + `shared/shell/repo/identity-repo`) | §4.1. Every source links by CUI through this; the reference module must not fork it. |
| `Territory` type, `TerritoryRepo` (`byTerritorialSiruta`, `byCounty`, `searchUat`, `listCounties`, `listRegions`) | **KERNEL** (`shared/shell/repo/territory-repo`) | §4.2. All geographic filters across all sources resolve here. |
| `Entity` GraphQL join type, shared scalars (`CUI`, `SIRUTA`, `BigInt`, `Money`, `Date`) | **KERNEL** (§6.2, §14.1) | Reference *extends* `Entity`, never redefines it. |
| Shared filter families (`Entity`, `Territory`, `Classification`) + the filter pipeline (`toTypeBox`/`toGraphQLInput`/`toConditionBuilders`/`canonicalizeFilters`) | **KERNEL** (§7, §14.2) | Reference declares specs that consume these; it invents no DSL. |
| `/api/v1/<domain>/filters/resolve` plumbing + the shared discovery-tool factory | **KERNEL** (§7.4) | Reference parameterizes it for its dimensions. |
| **The public-entity registry surface** (`core.public_entities`): list/filter/detail/search; `default_report_type`, `issues`, `field_trace`, UAT-mapping provenance, parent creditors | **REFERENCE MODULE** | Budget-world registry, kept as-is per §4.1; no other module exposes it. |
| **The territory/UAT browse surface** (`core.territories`): list/filter/detail, counties index, regions index, UAT autocomplete — as *public REST/GraphQL/MCP endpoints* | **REFERENCE MODULE** | The kernel `TerritoryRepo` is an internal port; the reference module is the only module that turns it into a public reference API. |
| **The classification-code lookup surface** (`core.classification_codes` = CAEN rev1/2/3): list/filter/detail, code→label resolve | **REFERENCE MODULE** | The kernel `Classification` *filter family* drives other sources' filters; exposing the CAEN dictionary as a browseable/resolvable reference endpoint is reference-module work. |
| **The identity-reference surface** (read-through to kernel `IdentityRepo`): org-by-CUI reference card, identifier list, name→CUI resolve | **REFERENCE MODULE** (thin pass-through to kernel repo) | The kernel repo is internal; the reference module exposes the *public reference endpoints* (`GET /api/v1/reference/organizations/...`). It adds no identity logic. |

**Non-duplication rule (binding for this module):** the reference module's repo
holds **only** queries that no kernel repo already provides. Concretely it owns a
`PublicEntityRepo` and a `ClassificationRepo` (new — nothing in the kernel reads
`core.public_entities` or `core.classification_codes` as a browseable surface),
and it **reuses** the kernel `IdentityRepo` and `TerritoryRepo` verbatim for the
identity/territory reference endpoints. If a method already exists on a kernel
repo, the reference shell calls it; it does not re-implement it.

**Naming:** REST prefix is **`/api/v1/reference/`**. GraphQL types are prefixed
**`Reference*`** for module-owned shapes (`ReferencePublicEntity`,
`ReferenceClassificationCode`) and reuse the kernel's `Organization`/`Territory`
types directly for the pass-through surfaces (those are kernel types, already
domain-unambiguous and shared by every module — re-prefixing them would fork the
kernel). MCP tools are `<verb>_reference_<noun>`.

---

## 1. Summary & data status

**What's in prod now** (live counts, `transparenta_prod`, 2026-06-16):

| Table | Rows | Notes |
|---|---:|---|
| `core.organizations` | 3,985,167 | **All `kind='company'`, `first_seen_source='onrc'`** today. The public-entity orgs are *not yet* in this hub — they live in `core.public_entities`. All rows carry CUI. PK `org_id` bigint; unique `cui`. |
| `core.organization_identifiers` | 8,072,163 | 2 schemes: `ro-cui` (3,985,167) + `onrc-cod-inmatriculare` (4,086,996), all `source='onrc'`. PK `(scheme,value)`; **no index on `org_id`** (see §3 risk). |
| `core.public_entities` | 15,002 | Budget-world registry, CUI PK. All have `territorial_siruta_code`. `is_uat=true`: 3,213. `issues` currently empty for all rows; `field_trace` populated. 11,695 have `parent1_cui`. |
| `core.territories` | 3,228 | All linked (`siruta_link_method` set), all have `population` and `uat_code`. 42 counties, 8 dev regions. PK surrogate `id` (the legacy `uat_id` contract); unique `territorial_siruta_code`. |
| `core.classification_codes` | 3,111 | **CAEN only**: `caen_rev2` (1,675), `caen_rev1` (785), `caen_rev3` (651). PK `(system, code)`. `parent_code` effectively unused (3 rows). **No functional/economic/CPV here** — those live in `budget.functional_classifications` / `budget.economic_classifications` (owned by the budget module). |

**Distributions that drive filter enums (live):**

- `public_entities.entity_type` (14 values): `education` 6,723 · `uat` 3,213 ·
  `public_entity` 2,067 · `health` 629 · `public_order` 590 · `culture` 438 ·
  `sports` 415 · `social` 332 · `utilities` 200 · `research` 152 · `justice` 128
  · `central_authority` 57 · `penitentiary` 42 · `transport` 16.
- `public_entities.category` (~50 values): `education_school` 4,148 ·
  `uat_commune` 2,847 · `education_high_school` 1,415 · … `uncategorized` 370.
  **Open enum** — treat as free string filter, not a closed enum (§7).
- `territories.region` (8): Sud-Muntenia, Nord-Est, Sud-Vest Oltenia, Nord-Vest,
  Centru, Sud-Est, Vest, Bucuresti-Ilfov.

**What's deferred / NOT served here:**

- **Website/contact profile** (`website_url`, `official_email`, `phone_*`,
  `leader_*`) lives **only in the raw DB** `transparenta_eu_public_entities`
  (`source_public_entities.website_contact_records`, 3,220 rows — see
  `PUBLIC_ENTITY_WEBSITE_CONTACTS_NOTES.md`). It is **not projected into
  `transparenta_prod` core** in the current snapshot. The legacy server's
  `EntityProfile` (website/email/leader) was served from a dev DB, not from
  prod. **Decision (open, §13 Q1):** this plan exposes website/contacts as a
  **capability-gated optional field** that returns `null` + a caveat until a
  scrapper `search` lane or a `core.public_entity_contacts` projection ships.
  The module must not hard-depend on it.
- **INS statistical datasets** — the legacy `ins` module served INS census/
  indicator datasets from a dedicated `ins.*` schema that **does not exist in the
  `transparenta_prod` snapshot** (no `ins.tsv`). INS data is *not in the serving
  DB yet*. **Decision (§13 Q2):** the "ins" in this module's title is honored as
  the **territory/UAT + population reference surface** (`core.territories` carries
  `population`, the only INS-derived measure in prod). Full INS dataset/observation
  browsing is **out of scope** for v1 and tracked as a future `ins` slice; this
  plan notes the supersession but ships no INS dataset endpoints.
- Cross-registry org merge (companies ↔ public entities) is deferred per
  DESIGN.md (link-not-merge); the reference module surfaces both registries
  side-by-side and lets the kernel `Entity` join correlate by CUI.

**Source prod schema(s):** `core` (shared kernel schema). Freshness signal:
`etl.load_runs` filtered to `source_id IN ('core-reference','public-entities',
'territories')` (§10).

---

## 2. Schema → domain model

Table-by-table mapping to module `core/types.ts` view models. Scalars per §14.1
(`org_id` bigint→string; `cui` text; `siruta` canonicalized to text — note
`core.organizations.siruta_code` is **integer**, `territories.*`/`public_entities.*`
are **text**, so we `::text`-cast on read for a uniform `SIRUTA` scalar).

### 2.1 `core.public_entities` → `ReferencePublicEntity` (module-owned)

```ts
// reference/core/types.ts
export interface ReferencePublicEntity {
  readonly cui: string;                       // core.public_entities.cui (PK)
  readonly name: string;
  readonly address: string | null;
  readonly entityType: string | null;        // entity_type (14-value open enum)
  readonly category: string | null;          // category (~50-value open enum)
  readonly tags: readonly string[];           // jsonb array
  readonly isUat: boolean;
  readonly territorialSirutaCode: string | null;   // link to territory hub (no FK)
  readonly uatMapping: {                      // provenance — reference-only attrs
    readonly method: string | null;           // uat_mapping_method
    readonly confidence: string | null;       // uat_mapping_confidence
    readonly unresolvedReason: string | null; // uat_unresolved_reason
  };
  readonly parents: { readonly cui1: string | null; readonly cui2: string | null }; // parent1_cui/parent2_cui
  readonly mainCreditors: readonly unknown[]; // main_creditors jsonb (passthrough)
  readonly defaultReportType: string;         // default_report_type
  readonly issues: readonly unknown[];        // issues jsonb (data-quality pattern, §4.1)
  readonly fieldTrace?: Record<string, unknown>; // field_trace — debug-only, behind ?include=trace
  readonly updatedAt: string;                 // updated_at ISO
}
```

- **Territory enrichment:** `territorialSirutaCode` resolves through the kernel
  `TerritoryRepo.byTerritorialSiruta` for canonical `countyName`/`region`/
  `population` (the registry row only carries the link key + provenance). The
  detail view-model embeds a `ReferenceTerritoryRef { sirutaCode, name, countyName,
  region, population } | null`.
- **Identity correlation:** `cui` is the kernel `Entity` join key. The detail
  resolver attaches `Entity` so a public entity links to its companies-domain /
  budget / procurement slices via the contributor registry (§4 / §6).
- **PII/excluded by default:** `field_trace` (debug provenance) is excluded from
  default projection — only returned when `?include=trace` (REST) /
  `fieldTrace @include` is explicitly requested, and never in MCP output. No
  party/contact PII lives in this table (website/contacts are raw-only, §1).

### 2.2 `core.territories` → kernel `Territory` (kernel-owned; reused by reference — NOT redefined here)

The `Territory` interface is **defined once in `shared/core/types.ts`** (kernel,
§4.2). The reference module imports it and adds no fields. It is **not restated in
this plan** to avoid the type forking the kernel. The kernel `Territory` maps the
live `core.territories` columns: `id` (surrogate, the legacy `uat_id` contract),
`territorial_siruta_code` (unique natural key), `siruta_code`, `county_siruta_code`,
`uat_code`, `name`, `county_code`, `county_name`, `region` (8 dev regions),
`population`. **Coordination ask for the kernel plan (§13 Q7):** the reference UAT
browse surface wants the link-provenance columns `siruta_link_method` /
`siruta_link_confidence` exposed as optional `linkMethod`/`linkConfidence` on the
kernel `Territory` (debug-only, behind explicit selection). If the kernel declines,
reference omits them — it does **not** fork `Territory` to add them.

Reference adds two derived list shapes over the same table (no new columns):
`ReferenceCounty { countyCode, countyName, region, uatCount, population }` and
`ReferenceRegion { region, countyCount, uatCount }` — both are `GROUP BY`
projections, not stored rows. (`population` is `SUM(t.population)` for the county;
the GraphQL SDL §6.1 carries the same field set.)

### 2.3 `core.classification_codes` → `ReferenceClassificationCode` (module-owned)

```ts
export interface ReferenceClassificationCode {
  readonly system: string;     // 'caen_rev1' | 'caen_rev2' | 'caen_rev3'
  readonly code: string;
  readonly label: string;
  readonly parentCode: string | null;   // present, but ~unused in CAEN
}
```

Closed `system` enum (3 values, live-verified). The CAEN dictionary is the
resolvable reference; **functional/economic/CPV classification lookups belong to
the budget and procurement modules** (their tables, their endpoints) — the
reference module explicitly does not serve them (§13 note).

### 2.4 `core.organizations` + `core.organization_identifiers` → kernel `Organization` / `OrgIdentifier`

Reused verbatim from the kernel (§4.1). The reference module exposes thin
read-through endpoints (`reference/organizations`) but adds **no** new type and
**no** new repo method beyond what the kernel `IdentityRepo` provides. The org
view-model returned by reference endpoints is the kernel `Organization`
(§14.1: `orgId` is a `string`).

---

## 3. Repo interface (ports)

Two **new** module-owned repos; the identity/territory repos are **kernel ports
injected as deps** (not redefined). All methods return `Result<T, ApiError>`
(neverthrow, §5.1).

### 3.1 `PublicEntityRepo` (module-owned — only reader of `core.public_entities`)

```ts
// reference/core/ports.ts
export interface PublicEntityRepo {
  // detail — PK lookup on core.public_entities (public_entities_pkey)
  findByCui(cui: string): Promise<Result<ReferencePublicEntity | null, ApiError>>;

  // list+filter+paginate — offset (15k rows, count is cheap; §14.4)
  list(input: PublicEntityListInput): Promise<Result<Paged<ReferencePublicEntity>, ApiError>>;

  // name autocomplete — public_entities_name_trgm_idx (GIN pg_trgm)
  searchByName(q: string, limit: number): Promise<Result<readonly ReferencePublicEntity[], ApiError>>;

  // resolve name|cui → {cui, name, score} for the discovery tool (§7.4)
  resolve(q: string, limit: number): Promise<Result<readonly PublicEntityMatch[], ApiError>>;

  // children of a creditor (parent1_cui/parent2_cui) — for the org tree
  findChildren(parentCui: string): Promise<Result<readonly ReferencePublicEntity[], ApiError>>;

  // aggregate — counts by entity_type / category / county (GROUP BY, indexed)
  aggregate(by: 'entity_type' | 'category' | 'is_uat' | 'county', input: PublicEntityFilter):
    Promise<Result<readonly { key: string; count: number }[], ApiError>>;
}
```

Index/perf notes:
- `findByCui` → `public_entities_pkey` (PK). O(1).
- `list` filters: `entity_type` → `public_entities_entity_type_idx` (partial);
  `category` → `public_entities_category_idx`; `territorial_siruta_code` →
  `public_entities_territorial_siruta_code_idx`; `is_uat`/`tags` → seq-scan over
  15k rows, acceptable (bounded; `tags` has **no** GIN index — see §7.1). County/
  region filter joins `core.territories` on `territorial_siruta_code` (the join
  key is `public_entities_territorial_siruta_code_idx` × `territories`'
  unique-keyed `territorial_siruta_code`), then filters `t.county_code` (indexed)
  / `t.region` (**no region index** — seq within the 3,228-row dim, cheap).
- `findChildren`/`parentCui` → **no index on `parent1_cui`/`parent2_cui`** (the
  migration creates none); an `OR` across the two columns is a seq-scan over 15k
  rows — acceptable/bounded for now. Recommend the scrapper add
  `public_entities_parent1_cui_idx` if the org-tree becomes hot (kernel/scrapper
  coordination, §13 Q3).
- `searchByName` → GIN trigram (`public_entities_name_trgm_idx`) with
  `similarity()` ordering; ILIKE fallback if `pg_trgm` missing (mirror kernel
  `searchByName`, §1 prior art). 5s class.
- `aggregate` by `county` joins territories; otherwise pure GROUP BY on indexed
  columns. 15s class.

### 3.2 `ClassificationRepo` (module-owned — only reader of `core.classification_codes`)

```ts
export interface ClassificationRepo {
  // detail — PK (system, code)
  findOne(system: string, code: string): Promise<Result<ReferenceClassificationCode | null, ApiError>>;

  // list+filter — system (enum), code prefix, label contains
  list(input: ClassificationListInput): Promise<Result<Paged<ReferenceClassificationCode>, ApiError>>;

  // resolve label|code → codes for discovery (§7.4)
  resolve(system: string | null, q: string, limit: number):
    Promise<Result<readonly ReferenceClassificationCode[], ApiError>>;

  listSystems(): Promise<Result<readonly { system: string; count: number }[], ApiError>>;
}
```

Index/perf: PK lookup on `(system, code)`; prefix filter on `code` uses the PK
btree (`system='caen_rev2' AND code LIKE '12%'` is index-prunable on the leading
columns); `label` contains is a seq-scan over ≤1,675 rows (trivial). All 5s class.

### 3.3 Kernel ports consumed (NOT redefined here)

- `IdentityRepo` (`shared`): `findByCui`, `findByOrgId`, `getIdentifiers(orgId)`,
  `searchByName`, `resolve`. Reference's `reference/organizations` endpoints call
  these directly. **Risk (carried to the kernel, §13 Q3):** there is **no index
  on `core.organization_identifiers(org_id)`** (PK is `(scheme,value)`), so
  `getIdentifiers(orgId)` is a seq-scan over 8.07M rows. The reference plan
  flags this as a kernel-owned index gap; the reference identifier-list endpoint
  must be cursor/limited and cached, and the plan recommends the scrapper add
  `organization_identifiers_org_id_idx`.

`Paged<T>` and `Cursor<T>` are the kernel pagination shapes (§5.3).

---

## 4. Usecases

Framework-free, over ports, returning `Result<T, ApiError>` (§2 hexagonal rule).

| Usecase | Signature (input → output) | Repo(s) | Notes |
|---|---|---|---|
| `getPublicEntity` | `{cui, includeTrace?}` → `ReferencePublicEntity` (+ embedded `TerritoryRef`) | PublicEntityRepo + kernel TerritoryRepo | NotFound if missing |
| `listPublicEntities` | `PublicEntityListInput` → `Paged<ReferencePublicEntity>` | PublicEntityRepo (+ territories for county filter) | offset pagination |
| `searchPublicEntities` | `{q, limit}` → `ReferencePublicEntity[]` | PublicEntityRepo | trigram |
| `aggregatePublicEntities` | `{by, filter}` → `{key,count}[]` | PublicEntityRepo | registry stats |
| `getPublicEntityTree` | `{cui}` → `{entity, children[]}` | PublicEntityRepo | parent-creditor tree |
| `getTerritory` | `{idOrSiruta}` → `Territory` | kernel TerritoryRepo | accepts surrogate id OR territorial_siruta |
| `listTerritories` | `TerritoryListInput` → `Paged<Territory>` | kernel TerritoryRepo | offset |
| `searchUat` | `{q, limit}` → `Territory[]` | kernel TerritoryRepo | trigram |
| `listCounties` | `{}` → `ReferenceCounty[]` | kernel TerritoryRepo (GROUP BY) | 42 rows, cached long |
| `listRegions` | `{}` → `ReferenceRegion[]` | kernel TerritoryRepo (GROUP BY) | 8 rows, cached long |
| `getClassificationCode` | `{system, code}` → `ReferenceClassificationCode` | ClassificationRepo | |
| `listClassificationCodes` | `ClassificationListInput` → `Paged<…>` | ClassificationRepo | offset |
| `getOrganizationRef` | `{cui}` → `Organization` | kernel IdentityRepo | thin pass-through |
| `listOrganizationIdentifiers` | `{cui, limit, cursor?}` → `Cursor<OrgIdentifier>` | kernel IdentityRepo | cursor (8M table, §3 risk) |
| `resolveReference` | `{dim, q, limit}` → `ResolveHit[]` | dim-routed (entity/territory/classification/org) | backs `/filters/resolve` + discovery MCP |

**Cross-source contributor (§4.4 / §14.7).** The reference module registers a
`SourceContributor` with `source: 'reference'`:

```ts
presenceFor(cui): // true if cui ∈ core.public_entities (registry membership)
  → SourcePresence | null            // { source:'reference', kind:'public_entity', label, count:1 }
profileSlice(cui): // the public-entity registry card for Entity.reference
  → EntityProfileSlice | null        // { publicEntity: ReferencePublicEntity, territory: TerritoryRef }
```

This is what powers `Entity.reference` in GraphQL and the registry slice of the
kernel `entity-360`. The **same `profileSlice(cui)`** is what the GraphQL
`Entity.reference` resolver calls (§14.7 — no divergent path).

- **`flow_type` registered:** none. The reference module produces no money flows.
- **`doc_type` registered:** none in v1 (the registry is not a `search.documents`
  contributor today — the scrapper `search` lane does not project public_entities;
  §9). If a future slice adds `public_entity` docs, this plan is the place to
  declare it.

---

## 5. REST endpoints

Prefix `/api/v1/reference/`. Every route: TypeBox on query/params; envelope
`{ ok, data, meta?, requestId }` (§5.2 / §14.11); `config: { public: true }`
(§14.11 — per-route flag, not prefix bypass). All read-only.

| # | Method · Path | Query/params (TypeBox) | Response | Pagination | Cache TTL | stmt-timeout |
|---|---|---|---|---|---|---|
| R1 | `GET /reference/public-entities` | `PublicEntityFilter` (§7.1) + `page,pageSize,sort` | `ReferencePublicEntity[]` | offset (`meta.page`) | 5 min | 5s |
| R2 | `GET /reference/public-entities/:cui` | path `cui:CUI`; `?include=trace` | `ReferencePublicEntity` (+ `territory`) | — | 5 min | 5s |
| R3 | `GET /reference/public-entities/:cui/children` | path `cui` | `ReferencePublicEntity[]` | offset | 5 min | 5s |
| R4 | `GET /reference/public-entities/aggregate` | `by:enum(entity_type,category,is_uat,county)` + `PublicEntityFilter` | `{key,count}[]` | — | 30 min | 15s |
| R5 | `GET /reference/territories` | `TerritoryFilter` (§7.1) + `page,pageSize,sort` | `Territory[]` | offset | 30 min | 5s |
| R6 | `GET /reference/territories/:id` | path `id` (surrogate **or** `siruta:` prefix → territorial_siruta) | `Territory` | — | 30 min | 5s |
| R7 | `GET /reference/counties` | — | `ReferenceCounty[]` (42) | — | 6 h | 5s |
| R8 | `GET /reference/regions` | — | `ReferenceRegion[]` (8) | — | 6 h | 5s |
| R9 | `GET /reference/classification-codes` | `ClassificationFilter` (§7.1) + `page,pageSize` | `ReferenceClassificationCode[]` | offset | 6 h | 5s |
| R10 | `GET /reference/classification-codes/:system/:code` | path `system,code` | `ReferenceClassificationCode` | — | 6 h | 5s |
| R11 | `GET /reference/classification-systems` | — | `{system,count}[]` | — | 6 h | 5s |
| R12 | `GET /reference/organizations/:cui` | path `cui:CUI` | `Organization` (kernel) | — | 5 min | 5s |
| R13 | `GET /reference/organizations/:cui/identifiers` | path `cui`; `limit,cursor` | `OrgIdentifier[]` | cursor (`meta.cursor`) | 5 min | 5s |
| R14 | `GET /reference/filters/resolve` | `dim:enum(public_entity,territory,classification,organization), q, limit` | `ResolveHit[]` | — | 5 min | 5s |

OpenAPI: the module exports one fragment merged by the kernel into
`/api/v1/openapi.json` (§6.1). `R6` documents the dual-id grammar (`123` =
surrogate id; `siruta:1234567` = territorial_siruta_code) explicitly.

Notes / guards:
- **R12/R13 caveat:** `core.organizations` is companies-only today (§1) — a
  public-entity CUI will 404 on R12 *unless* it also exists as an ONRC org. R12's
  description states this; the registry detail (R2) is the authoritative
  public-entity surface. (If/when public entities are added to `core.organizations`,
  R12 covers both with no API change.)
- **R13** is cursor-paginated and capped (`limit ≤ 100`) precisely because of the
  missing `org_id` index (§3.3 risk). Its cursor encodes the sort tuple
  `(scheme, value)` — the `organization_identifiers_pkey` order — per the §14.3
  envelope; `fhash` is over the single `cui` path param (no filter spec on R13).
- No mutations (read-only API, §6.1).

---

## 6. GraphQL

In-process schema stitch (§6.2). Module contributes SDL + resolvers that
**extend** root `Query` and the kernel `Entity` type. Module-owned types are
`Reference*`-prefixed (§14.8). Kernel `Organization`/`Territory` are reused
un-prefixed (they are kernel base types — re-prefixing would fork the kernel).
This is a **declared deviation** from the literal §14.8 prefix rule, pending the
foundation-plan exemption requested in §13 Q7.

### 6.1 SDL (module-owned types + Query extensions)

```graphql
# reference/shell/graphql/typedefs.ts  (kernel owns scalars CUI, SIRUTA, BigInt, Date, JSON)

type ReferencePublicEntity {
  cui: CUI!
  name: String!
  address: String
  entityType: String
  category: String
  tags: [String!]!
  isUat: Boolean!
  territory: Territory                 # kernel type, resolved via TerritoryRepo + DataLoader
  uatMapping: ReferenceUatMapping!
  parents: ReferenceParentCreditors!
  defaultReportType: String!
  issues: [JSON!]!
  fieldTrace: JSON                     # nullable; only populated when explicitly selected
  updatedAt: DateTime!
  entity: Entity                       # kernel join → cross-source correlation by CUI
}
type ReferenceUatMapping { method: String, confidence: String, unresolvedReason: String }
type ReferenceParentCreditors { cui1: CUI, cui2: CUI }

type ReferenceClassificationCode { system: String!, code: String!, label: String!, parentCode: String }
type ReferenceCounty { countyCode: String!, countyName: String!, region: String!, uatCount: Int!, population: Int }
type ReferenceRegion { region: String!, countyCount: Int!, uatCount: Int! }
type ReferenceResolveHit { dim: String!, value: String!, label: String!, score: Float }

# Relay connections (§5.3) reuse the kernel cursor encoder
type ReferencePublicEntityConnection { edges: [ReferencePublicEntityEdge!]!, pageInfo: PageInfo! }
type ReferencePublicEntityEdge { node: ReferencePublicEntity!, cursor: String! }

extend type Query {
  referencePublicEntity(cui: CUI!): ReferencePublicEntity
  referencePublicEntities(filter: ReferencePublicEntityFilter, page: PageInput, sort: ReferencePublicEntitySort): ReferencePublicEntityConnection!
  referencePublicEntityAggregate(by: ReferenceAggregateDim!, filter: ReferencePublicEntityFilter): [ReferenceCountBucket!]!
  referenceTerritory(id: ID, siruta: SIRUTA): Territory
  referenceTerritories(filter: ReferenceTerritoryFilter, page: PageInput, sort: ReferenceTerritorySort): TerritoryConnection!
  referenceCounties: [ReferenceCounty!]!
  referenceRegions: [ReferenceRegion!]!
  referenceClassificationCodes(filter: ReferenceClassificationFilter, page: PageInput): ReferenceClassificationCodeConnection!
  referenceClassificationCode(system: String!, code: String!): ReferenceClassificationCode
  referenceOrganization(cui: CUI!): Organization        # kernel type
  referenceResolve(dim: ReferenceResolveDim!, q: String!, limit: Int = 10): [ReferenceResolveHit!]!
}
```

### 6.2 `Entity` extension + DataLoaders (§6.2 / §14.7)

```graphql
extend type Entity {
  reference: ReferencePublicEntity   # the registry card, if this CUI is a public entity
}
```

Resolver calls **`contributor.profileSlice(cui)`** (the same usecase REST
entity-360 uses, §14.7) through a **DataLoader keyed by CUI** (`§14.1` — CUI, not
org_id) so an entity-360 fan-out batches one `WHERE cui = ANY($1)` against
`core.public_entities`. `ReferencePublicEntity.territory` and
`ReferencePublicEntity.entity` are each their own CUI/siruta-keyed DataLoader to
avoid N+1 on lists. Resolvers are thin: parse args → call the core usecase
(§6.2). Filter `input` types are **generated** from the §7 specs via the kernel
`toGraphQLInput` deriver — never hand-written.

---

## 7. Filters

The kernel ships the pipeline (§14.2); this module **declares specs**. Each spec
field carries `ops` (incl. mandatory `isNull` for coverage questions, §14.2).
Three collection specs.

### 7.1 Collection filter specs

**`public_entities` spec** (driving table `core.public_entities`, alias `pe`):

| Field | type | ops | driving column / index | REST param | GraphQL input | exclude? |
|---|---|---|---|---|---|---|
| `cui` | string | eq,in | `pe.cui` (PK) | `cui` / `cui[]` | `cui: [CUI!]` | yes |
| `name` | string | contains,prefix | `pe.name` (GIN trgm) | `name` | `name: String` | no |
| `entityType` | enum(14) | eq,in,isNull | `pe.entity_type` (partial idx) | `entityType[]` | `entityType: [String!]` | yes |
| `category` | string | eq,in,prefix,isNull | `pe.category` (idx) | `category[]` | `category: [String!]` | yes |
| `isUat` | bool | eq | `pe.is_uat` (seq, 15k) | `isUat` | `isUat: Boolean` | no |
| `tags` | string(array) | contains | `pe.tags @> to_jsonb(array[$])` — **no GIN idx**, seq 15k | `tag[]` | `tags: [String!]` | no |
| `sirutaCode` | string | eq,in,isNull | `pe.territorial_siruta_code` (idx) | `siruta[]` | `siruta: [SIRUTA!]` | yes |
| `countyCode` | string | eq,in | join `territories` on `territorial_siruta_code` (uq×idx) → filter `t.county_code` (idx) | `countyCode[]` | `countyCode: [String!]` | yes |
| `region` | enum(8) | eq,in | join `territories` (as above) → filter `t.region` (**no idx**, seq in 3,228-row dim) | `region[]` | `region: [String!]` | yes |
| `parentCui` | string | eq | `pe.parent1_cui OR pe.parent2_cui` (**no idx**, seq 15k) | `parentCui` | `parentCui: CUI` | no |
| `hasIssues` | bool | eq | `jsonb_array_length(pe.issues) > 0` | `hasIssues` | `hasIssues: Boolean` | no |
| `defaultReportType` | string | eq,in | `pe.default_report_type` | `defaultReportType[]` | — | no |

`sort`: default `name asc`; allowed `name`, `cui`, `entity_type`, `updated_at`.

**`territories` spec** (driving table `core.territories`, alias `t`) — reuses the
kernel **Territory filter family** (§7.2) verbatim; module adds nothing beyond
what the family declares:

| Field | type | ops | column / index | exclude? |
|---|---|---|---|---|
| `id` | int | eq,in | `t.id` (PK) | no |
| `sirutaCode` | string | eq,in | `t.siruta_code` (idx) | yes |
| `territorialSiruta` | string | eq,in | `t.territorial_siruta_code` (uq) | no |
| `countyCode` | string | eq,in | `t.county_code` (idx) | yes |
| `region` | enum(8) | eq,in | `t.region` (**no idx**, seq in 3,228 rows) | yes |
| `name` | string | contains,prefix | `t.name` (GIN trgm) | no |
| `isUat` | bool | eq | derived `t.uat_code IS NOT NULL` | no |
| `minPopulation` / `maxPopulation` | int | gte / lte (`between`) | `t.population` | no |

`sort`: default `name asc`; allowed `name`, `population`, `county_code`.

**`classification_codes` spec** (driving table `core.classification_codes`, alias `c`):

| Field | type | ops | column / index | exclude? |
|---|---|---|---|---|
| `system` | enum(3) | eq,in | `c.system` (PK leading col) | no |
| `code` | string | eq,in,prefix | `c.code` (PK) | yes |
| `codePrefix` | string | prefix | `c.code LIKE q||'%'` | no |
| `label` | string | contains | `c.label` | no |
| `parentCode` | string | eq,isNull | `c.parent_code` | yes |

`sort`: default `code asc`; allowed `code`, `label`.

### 7.2 Surface mapping (§7.3 rules)

- REST arrays → repeated query param **or** CSV (declare: **CSV**, e.g.
  `?entityType=education,health`); ranges → `minPopulation`/`maxPopulation`;
  exclusion → `exclude.entityType=...` bracket form.
- GraphQL → one `input ReferenceXFilter` (generated by `toGraphQLInput`); arrays
  are lists; population range is `population: { from, to }`; exclusion is nested
  `exclude: ReferenceXFilter`.
- MCP → same field names as REST; the discovery tool resolves Romanian
  names→values first (§8).
- **`tags.contains` op note:** `tags` is a jsonb-array column; its kernel
  `contains` op compiles to `pe.tags @> to_jsonb(array[$1])` (membership), not a
  text substring. The kernel composer must special-case array-typed fields when
  emitting `contains`. No GIN index today → seq within 15k rows (acceptable).
- **Negation asymmetry note (siruta fields):** `sirutaCode`/`territorialSiruta`
  carry different `exclude?` flags deliberately — `sirutaCode` (the join/territory
  link) is negatable for "all UATs *except* these"; `territorialSiruta` is the
  exact PK-grade lookup where negation has no use case, so it is not negatable.
- `canonicalizeFilters(input)` (kernel) produces the cache key + cursor `fhash` +
  the tri-surface equivalence test fixture (§14.2/§14.3) for all three specs.

### 7.3 Discovery / name-resolution dimensions (§7.4)

The reference module exposes **four** resolve dimensions (`dim` param of R14 /
the discovery MCP tool):

| dim | input | resolves to | backing |
|---|---|---|---|
| `public_entity` | Romanian institution name | `{ cui, name, county, score }` | `public_entities_name_trgm_idx` |
| `territory` | locality/UAT name | `{ territorialSiruta, name, countyName, region }` | `territories_name_trgm_idx` |
| `classification` | CAEN label or code fragment | `{ system, code, label }` | `classification_codes` |
| `organization` | company name | `{ orgId, cui, name }` | kernel `IdentityRepo.searchByName` |

This is the **canonical name→value resolver** the foundation calls shared kernel
infra (§7.4); reference is the source plan that declares the `public_entity`,
`territory`, and `classification` dimensions (and reuses the kernel's
`organization` dimension). Other source modules' discovery tools call these same
resolvers for buyer-institution (PC-1), territory (XS-5), and CAEN dimensions.

### 7.4 Golden question→filter examples (from `AI_AGENT_FILTER_QUESTION_CATALOG.md`)

| Catalog ref | Question | Resolved filter |
|---|---|---|
| Canonical "Buyer institution" | "spending of *Primăria Cluj-Napoca*" | `resolve(public_entity,'Primaria Cluj-Napoca')` → `cui` → R2 → hand `cui` to budget/procurement |
| Canonical "Buyer territory" | "UATs in *Cluj* county" | `R5 territories?countyCode=CJ` (after `resolve(territory,...)` or `listCounties`) |
| XS-5 | "Region *Nord-Vest* public entities" | `R1 public-entities?region=Nord-Vest` |
| Coverage gate | "which public entities have unresolved UAT mapping?" | `R1 public-entities?...&exclude.sirutaCode=isNull` + `uatMapping.unresolvedReason` |
| PC-2 (CPV resolve) | "CAEN code for *fabricarea painii*" | `resolve(classification,'fabricarea painii')` → `{system:caen_rev2, code, label}` |
| Presence | "is CUI 4267117 a public entity?" | contributor `presenceFor('4267117')` / R2 |

---

## 8. MCP tools

Two families (§6.3): one discovery, query tools for each browseable collection.
TypeBox input+output; handler calls a core usecase; output is
`{ ok, kind, query, link, item|items, summary? }` (§6.3). Tool naming
`<verb>_reference_<noun>`. Rate-limited, bounded result sizes, no PII (`field_trace`
never emitted in MCP, §2.1).

| Tool | Input (TypeBox) | Output `kind` | Usecase | `link` deep-link | `summary` template |
|---|---|---|---|---|---|
| `resolve_reference_filter` (discovery) | `{ dim:enum(public_entity,territory,classification,organization), q:string, limit?:int }` | `resolution` | `resolveReference` | `/entities/{cui}` or `/territories/{siruta}` | "Resolved '{q}' → {n} match(es); top: {label} ({value})." |
| `get_reference_public_entity` | `{ cui:CUI }` | `public_entity` | `getPublicEntity` | `/entities/{cui}` | "{name} — {entityType}, {countyName}; default report {defaultReportType}." |
| `search_reference_public_entities` | `ReferencePublicEntityFilter + {limit?}` | `public_entity_list` | `listPublicEntities` | `/reference/public-entities?{filters}` | "{total} public entities match {filterSummary}." |
| `get_reference_territory` | `{ id?:int, siruta?:SIRUTA }` | `territory` | `getTerritory` | `/territories/{siruta}` | "{name}, {countyName} ({region}); population {population}." |
| `list_reference_uats` | `ReferenceTerritoryFilter + {limit?}` | `territory_list` | `listTerritories` | `/reference/territories?{filters}` | "{total} UATs match {filterSummary}." |
| `resolve_reference_classification` | `{ system?:enum, q:string, limit?:int }` | `classification_list` | `resolveReference(dim='classification')` | `/reference/classification-codes?...` | "CAEN matches for '{q}': {topCodes}." |

The discovery tool is the §7.4 shared infra parameterized for this module's four
dimensions. Every query-tool output echoes the **normalized filters applied** and
a **coverage** note (`AI_AGENT_FILTER_QUESTION_CATALOG` Core Rule) — e.g. the
public-entity aggregate reports the denominator (15,002) and the share matched.

---

## 9. Search integration

- **`doc_type`(s) owned: none in v1.** The scrapper `search` lane does not project
  `core.public_entities` into `search.documents` in the current snapshot, and the
  registry is small (15k) — name search is served directly by the
  `public_entities_name_trgm_idx` trigram (R1/R14, fast, always-available). This
  avoids a search-service hard-dependency for the primary registry lookup.
- **Meili/OpenSearch usage:** the reference module is a **consumer** of the
  kernel hybrid-search contract for *cross-source* search (it contributes the
  name→CUI/SIRUTA resolution that the kernel global search uses to scope by
  institution/territory), but it owns **no** Meili/OS index of its own in v1.
- **Semantic gating (§14.5):** N/A — reference has no semantic fields. If a future
  slice projects `public_entity` docs (with a `doc_type='public_entity'`), this
  section is where it declares Meili index name, OS index, and the
  capability-gated semantic field; until then, capability checks are moot.
- **Recommendation (carried to scrapper):** if entity-name autocomplete needs to
  span *all* registries (companies + public entities) in one Meili call, add a
  `public_entity` projection to the `search` lane — but that is a scrapper change,
  noted here, not built in the server.

---

## 10. Sync / freshness impact on serving

- **Loader cadence:** `core.*` reference is **slowly-changing** — public entities
  refresh on the budget-official load cadence (periodic), territories essentially
  static (SIRUTA reference), CAEN static. So cache TTLs are long: counties/regions/
  classification 6 h; territories 30 min; public-entity detail/list 5 min.
- **Freshness / "as-of" (§14.11):** the module surfaces a `meta.asOf` watermark
  read from `etl.load_runs` (latest `finished_at` where `status='succeeded'` and
  `source_id` in the reference set) on R1/R2/R4 and on the GraphQL connection's
  `pageInfo`. Cache is busted by a per-domain loader-completion version stamp
  derived from that `run_id`; if no `core`-tagged load run exists yet, **TTL-only
  is the interim** (stated explicitly per §14.11).
- **Mutable records:** public-entity rows are **upserted** by the loader (the
  `field_trace`/`issues`/`updated_at` pattern), so reads always reflect the latest
  load; no append-only history is exposed. `default_report_type` is loader-
  recomputed (migration note) — the API never derives it.

---

## 11. Wiring

```ts
// reference/index.ts
export function makeReferenceModule(deps: {
  db: ProdKysely;                    // kernel-typed instance (core.* tables)
  identityRepo: IdentityRepo;        // KERNEL — injected, not constructed here
  territoryRepo: TerritoryRepo;      // KERNEL — injected
  cache: Cache; logger: Logger;
}): ReferenceModule {
  const publicEntityRepo = makePublicEntityRepo(deps.db);     // module-owned
  const classificationRepo = makeClassificationRepo(deps.db); // module-owned
  // usecases bind these + the injected kernel repos
  return { restPlugin, graphql: { typeDefs, resolvers }, mcpTools, contributor, repos };
}
```

- **`makeReferenceModule` deps:** kernel `db`, `identityRepo`, `territoryRepo`,
  `cache`, `logger`. It constructs only `PublicEntityRepo` + `ClassificationRepo`
  (the only readers of `core.public_entities` / `core.classification_codes`).
- **build-app registration (§10):** kernel built first (pool, kernel repos incl.
  identity+territory, middleware); then `makeReferenceModule(...)`; then register
  REST plugin under `/api/v1/reference`, merge GraphQL slice into root schema,
  register MCP tools, register the `reference` contributor into the kernel
  registry. Order is data-independent.
- **Env additions:** **none** — reference uses only `PROD_DATABASE_URL` + kernel
  config. (Website/contacts, if ever served, would add a raw-DB or projection
  knob — deferred, §1.)
- **Legacy modules superseded:** `src/modules/entity` (entity registry +
  `EntityProfile`), `src/modules/uat` (UAT registry), and the territory/population
  reference half of `src/modules/ins`. The **statistical INS dataset** half of
  `ins` and the `normalization` module are **not** superseded by this plan (no
  `ins.*` serving schema yet, §1 Q2) — they keep running on the legacy DB until a
  dedicated INS slice lands. New types/prefixes don't collide with legacy (§10).

---

## 12. Testing

- **Unit** (`tests/unit/reference/`): the four resolve dimensions + each usecase
  with mocked `PublicEntityRepo`/`ClassificationRepo`/kernel repos; filter-spec→SQL
  compilation snapshot tests for all three specs (incl. `exclude.*`, `isNull`,
  CSV-array parse, county-join filter); cursor encode/decode for R13;
  `canonicalizeFilters` stability (array sort, default fill) for the cache-key /
  `fhash` contract; the `R6` dual-id (`siruta:` vs surrogate) parse.
- **Integration** (`tests/integration/reference/`): REST + GraphQL + MCP against a
  seeded `core.*` fixture (a few public entities incl. one with `parent1_cui`, a
  county's worth of territories, a CAEN slice); **tri-surface equivalence** — the
  same logical filter via R1 / `referencePublicEntities` / `search_reference_public_entities`
  returns the same set (the §14.2 `canonicalizeFilters` guarantee). Contract test
  that `field_trace` is absent from default REST/GraphQL/MCP projections and only
  appears with explicit `include=trace`.
- **Golden filters** (from §7.4 / the catalog): the six rows above as integration
  cases asserting resolved filter values against the seeded fixture (deterministic
  CUI/SIRUTA/CAEN codes, per the Entity-Resolution gate — rank/resolve by id, not
  name).

---

## 13. Open questions / risks

1. **Website/contacts not in serving DB (§1).** They live only in raw
   `transparenta_eu_public_entities`. Confirm: do we (a) ship a scrapper `search`
   lane / `core.public_entity_contacts` projection so the reference detail can
   serve website/email/leader, or (b) keep them raw-only and have the API return
   `null` + caveat? Plan assumes (b) for v1 (capability-gated). **User/architecture
   decision.**
2. **INS scope (§1).** No `ins.*` schema in `transparenta_prod`. This plan honors
   "ins" as the territory/UAT + `population` reference surface and defers full INS
   dataset/observation browsing to a future slice. Confirm that's acceptable for
   v1 (the legacy `ins` GraphQL keeps running until then).
3. **Kernel index gap — `core.organization_identifiers(org_id)` (§3.3).** No index;
   `getIdentifiers(orgId)` seq-scans 8.07M rows. This is a **kernel/scrapper**
   issue (the reference module only consumes it). Recommend the scrapper add
   `organization_identifiers_org_id_idx`; until then R13 stays cursor+capped+cached.
4. **`core.organizations` is companies-only today (§1/§5 R12).** Public-entity
   orgs are not in the identity hub yet; R12 (org-by-CUI) will 404 for
   public-entity CUIs that aren't also ONRC companies. Confirm whether the budget
   load should also upsert public entities into `core.organizations` (would make
   the kernel hub the single org surface) — **cross-module / scrapper coordination**,
   not reference-owned.
5. **`category` is an open ~50-value set (§1).** Treated as free-string filter
   (eq/in/prefix), not a closed enum, so new loader categories don't break the
   schema. Confirm we don't want a curated closed enum for the client facets.
6. **Cross-module coordination:** (a) the budget module must reuse this module's
   `public_entity` + `territory` resolve dimensions for its buyer-institution /
   territory filters (don't fork); (b) procurement/budget classification lookups
   use *their* `budget.*` classification tables, **not** `core.classification_codes`
   (CAEN-only) — this plan does not serve functional/economic/CPV. The
   consistency pass must confirm no other module re-implements the public-entity or
   territory registry surface.
7. **§14.8 kernel-base-type exemption (amend the foundation plan).** This module
   reuses the kernel's **un-prefixed** GraphQL object types `Organization` and
   `Territory` (re-prefixing them would fork the kernel — §0/§6.1 rationale). But
   foundation §14.8 ("every module type/enum is always domain-prefixed; no bare
   generic names") declares an exemption only for *scalars* and the `Entity` join
   type, not for kernel object types. **Ask:** the consistency pass / foundation
   owner should add an explicit clause to `00` §14.8 declaring kernel-owned object
   types (`Organization`, `Territory`, `MoneyFlow`, `Document`) exempt from the
   prefix rule. Until ratified, this module's reuse of `Organization`/`Territory`
   is a *declared deviation* (foundation §3 permits stated deviations), not a
   silent violation. Also wants the kernel `Territory` to (optionally) carry
   `linkMethod`/`linkConfidence` (§2.2).
8. **Data-status counts are live-verified, not NOTES-sourced.** The §1 row counts
   and enum distributions (3,985,167 orgs; 15,002 public entities; CAEN-only
   classification; the 42-county/8-region territory split; the un-indexed
   `org_id`) were measured directly against `transparenta_prod` on griffin
   (2026-06-16), not lifted from NOTES — they are reproducible via
   `kubectl exec transparenta-prod-postgres-1 … psql`. The `etl.load_runs`
   `source_id` literals in §1/§10 are the one item **not** yet confirmed against
   the live loader and should be verified during implementation.
