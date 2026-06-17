# 09 — NGOs module (FORWARD-LOOKING plan)

> **Status:** FORWARD-LOOKING. Conforms to the binding contract
> [`00-foundation-shared-kernel.md`](00-foundation-shared-kernel.md). Follows the
> §12 template; sections that depend on data not yet in `transparenta_prod` are
> marked **DEFERRED — pending `ngo` domain**.
>
> **Hard prerequisite (read first):** there is **no `ngo` schema in
> `transparenta_prod`** today, and `core.organizations` holds **only
> `company`-kind rows** (3,985,167; `\dn` + `GROUP BY kind` verified live
> 2026-06-16). No `ngo_license` `flow_type` and no NGO `doc_type` exist in
> `flows.money_flows` / `search.documents`. This module **cannot be built until
> the scrapper lands an `ngo` domain in serving**. This plan defines the target
> module shape, the data-landing prerequisite, and the proposed entities /
> endpoints / filters / GraphQL / MCP for when the domain arrives — it does
> **not** fabricate live column lists.

---

## 1. Summary & data status

### 1.1 What is in prod now (NGOs): nothing

| Surface | State |
|---------|-------|
| `transparenta_prod` `ngo` schema | **absent** (15 schemas live; none is `ngo`) |
| `core.organizations.kind = 'ngo'` | **0 rows** (only `company`, 3.98M) |
| `flows.money_flows` NGO flow type | **absent** |
| `search.documents` NGO doc_type | **absent** |

Consequently §§2–9 below describe a **target** the scrapper must land first.
The module ships **disabled by default** (env feature flag off) until the domain
exists; enabling it against an empty/absent schema is a no-op, not an error.

### 1.2 The raw layer (source of truth) — what exists to draw from

The scrapper already runs an `ngos` **source-learning** raw lane
(`src/src/sources/ngos/`, experimental DB `experimental_ngos` on Unicorn
`192.168.100.200:55547`). It is a **presence-signal** corpus, not a clean NGO
registry. v1 measured counts (per
`experimental/docs/ngo/extraction-readiness-2026-05-21.md`):

| Raw object (`experimental_ngos`) | Role | v1 rows |
|----------------------------------|------|---------|
| `ngo_core.organization_profiles` | CUI-keyed NGO/org profile (name, legal_form, county, locality) | **9,945** |
| `ngo_core.cui_evidence` | per-source CUI evidence (which registry saw this CUI) | **10,565** |
| `ngo_core.license_accreditations` | sector accreditation/license rows (sector, authority, license_no, validity, status) | (per source; see below) |
| `ngo_core.public_money_events` | NGO public-money events (programme, project, amount, authority, role) — **PNRR/SMIS/SEAP referenced, not duplicated** | ref-only in v1 |
| `ngo_source.{anofm_rueis_entities, anofm_employment_providers, fpa_adult_training_providers, aracip_education_units, cnas_contracted_provider_rows}` | source-native minimized rows | RUEIS 9,172 · employment 1,383 · ARACIP 10 · CNAS 16 · FPA 0 |
| `ngo_core.privacy_controls` | per-source privacy class + allowed-field allowlist | seeded |

Extractable registries today: `anofm_rueis` (social enterprises), `anofm_employment_accreditation`,
`fpa_adult_training`, `aracip_education_units`, `cnas_contracted_providers`.
**Reference-only (never re-extracted here):** PNRR/SMIS, SEAP/SICAP, RegAS, CNA,
broad AEP. Planned-but-not-yet enrichment (research-ready, not loaded):
**ANAF fiscal status**, **ANAF/MF financials**, **ANAF deductible status**, and
the **MJ national NGO registry** (associations/foundations/federations) as the
*legal identity backbone* — sampled MJ headers do **not** expose CUI yet.

**Implication for the contract's "NGOs are CUI-keyed; benefit from #3
(companies) landed":** correct, but the *value* is mostly **cross-source** —
an NGO's CUI links into the already-landed `companies`/identity hub, `flows`
(once NGO flows land), procurement, and budget. The NGO-native surface (profile
+ accreditations + public-money events) is **thin and coverage-limited**; the
module's primary job is (a) an NGO **kind/registry filter** over the identity
hub and (b) a **contributor** that adds the NGO slice to entity-360. This is
explicitly *not* a high-volume analytics domain like procurement.

### 1.3 The source's prod schema(s)

**Proposed** `ngo` schema (to be designed/migrated by the scrapper — see §1.4).
The old unified stub assumed only `ngo.organizations` + `ngo.licenses`; this
plan recommends a slightly richer shape (adds `ngo.cui_evidence` and
`ngo.public_money_events`, plus optional `ngo.fiscal_status`/`ngo.financials`
when ANAF enrichment lands). Final column names are owned by the scrapper
migration; the server is read-only (F5).

### 1.4 Data-landing prerequisite (the gating checklist for the scrapper)

Before this module can be enabled, the scrapper must:

1. **Cut over** `experimental_ngos` raw DB to the prod raw cluster, retire the pod (Phase-1 DoD).
2. **Model** an `ngo` schema in `transparenta_prod` (Kysely prod-migration), at minimum:
   `ngo.organizations`, `ngo.licenses` (accreditations), `ngo.cui_evidence`;
   recommended `ngo.public_money_events`; deferred `ngo.fiscal_status`,
   `ngo.financials` (ANAF).
3. **Link to the identity hub by CUI** (link-not-merge, §4.1): annotate
   `core.organizations` for NGO CUIs and add `core.organization_identifiers` rows
   for the MJ registry number once the MJ backbone lands. **Beware the
   single-`kind`-column collision** — a CUI may already be a `company`-kind row
   (a social enterprise / NGO can also be in ONRC), so do **not** blindly
   overwrite `kind='ngo'` (that is a merge-by-mutation, §4.1 forbids it). See the
   §13.2 open question for the overlay-vs-badge decision. **Until NGO identity is
   linked, `Entity` cannot report NGO *kind*** (though the contributor badge in
   §1.4 note can still surface NGO-ness — see below).
4. **(Optional, when meaningful)** register an `ngo_license`/`ngo_public_money`
   `flow_type` in `flows.money_flows` and an `ngo_*` `doc_type` in
   `search.documents` via the scrapper `search` lane.
5. Publish row counts + a `*_NOTES.md` (per CLAUDE.md convention) so §1.1 can be
   filled with real numbers.

This plan's §§2–9 are written so that, once 1–3 land, implementation is
mechanical.

**Two decoupled capabilities** (do not conflate): the `kind='ngo'` *dimension*
(faceting/filtering `Entity` by NGO kind) needs step 3's identity-hub link; but
the entity-360 **NGO badge** (`isNgo` + sectors on the entity card) needs only
the `ngo.*` tables (step 2) + the registered contributor (§4.4) — it works
without the `core.organizations` overlay. So `Entity.ngo` (§6) can light up as
soon as `ngo.*` lands, even before the kind overlay.

---

## 2. Schema → domain model

> **DEFERRED — pending `ngo` domain.** Mapping below is against the **proposed**
> `ngo` schema (grounded in the raw `ngo_core.*` shape + the old unified stub).
> Column names finalize at scrapper-migration time.

| Proposed prod table | Module view model (`ngo/core/types.ts`) | Identity / territory | Notes |
|---------------------|------------------------------------------|----------------------|-------|
| `ngo.organizations` (`profile_key`, `cui`, `name`, `normalized_name`, `legal_form`, `county_name`, `locality_name`, `attrs`) | `NgoProfile { profileKey, cui, name, normalizedName, legalForm, countyName, localityName }` | `cui` → `core.organizations` (link-not-merge); `county_name`/locality denormalized; canonical territory via `core.territories` | `legal_form` enum: association/foundation/federation/social-enterprise/other |
| `ngo.licenses` (`license_key`, `cui`, `organization_name`, `sector`, `authority`, `license_no`, `valid_from`, `valid_to`, `status`, `county_name`) | `NgoAccreditation { licenseKey, sector, authority, licenseNo, validFrom, validTo, status, status_active(derived) }` | `cui` link | "license" ≙ sector accreditation (ANOFM/FPA/ARACIP/CNAS). `valid_*` are **text** in raw — parse defensively |
| `ngo.cui_evidence` (`source_name`, `source_record_key`, `cui`, `evidence_type`, `confidence`) | `NgoCuiEvidence { source, evidenceType, confidence }` | `cui` link | powers "which registries attest this NGO" coverage |
| `ngo.public_money_events` (recommended) | `NgoPublicMoneyEvent { programme, projectTitle, amountRon, authority, role, eventDate }` | `cui` link | **prefer the kernel flows view** for totals (§14.6 grain gate); this is native event detail only |
| `ngo.fiscal_status` / `ngo.financials` (ANAF, deferred) | `NgoFiscalStatus`, `NgoFinancials` | `cui` link | **DEFERRED** until ANAF enrichment lands |

**PII / excluded columns (hard, §8.2):** the raw `privacy_controls` allowlist is
the contract. **Never project** contact/person fields (FPA `drop_contacts`,
CNAS contacts) — they live only in raw evidence and must not appear in any prod
`ngo.*` serving table; if they do, the repo row type **structurally omits them**
(mirror of §14.9). The module's default projection is the `privacy_controls.allowed_fields`
set: `organization_name, cui, county, locality, address?, organization_type,
service_type, status, license_no, valid_from, valid_to, document_url, amount`.
`cnas_contracted_providers` is flagged `sensitive_sector` — health-provider rows
are organization-level only, never doctor/patient data.

---

## 3. Repo interface (ports)

> **DEFERRED — pending `ngo` domain** (interface is final-shapeable now; bodies
> wait on tables). All methods return `Result<T, ApiError>` (neverthrow).

```ts
// ngo/core/ports.ts
export interface NgoRepository {
  // detail
  findByCui(cui: string): Promise<Result<NgoProfile | null, ApiError>>;          // ngo.organizations (cui unique idx)
  getAccreditations(cui: string): Promise<Result<readonly NgoAccreditation[], ApiError>>; // ngo.licenses (cui idx)
  getCuiEvidence(cui: string): Promise<Result<readonly NgoCuiEvidence[], ApiError>>;       // ngo.cui_evidence (cui idx)

  // list / filter (offset pagination — small bounded corpus, ~10k rows)
  listProfiles(input: NgoProfileFilterInput, page: Page): Promise<Result<Paged<NgoProfile>, ApiError>>;
  listAccreditations(input: NgoAccreditationFilterInput, page: Page): Promise<Result<Paged<NgoAccreditation>, ApiError>>;

  // aggregate (cheap — small corpus)
  countBy(dim: 'county' | 'legal_form' | 'sector' | 'authority' | 'status',
          input: NgoProfileFilterInput): Promise<Result<readonly NgoBucket[], ApiError>>;

  // contributor support
  presence(cui: string): Promise<Result<{ isNgo: boolean; accreditationCount: number; sectors: string[] } | null, ApiError>>;
}
```

> **Kernel dependency (call out for the consistency pass):** the kernel
> `SourcePresence` type (contract §4.4) was a *fixed* boolean record in the old
> unified module (`{ isSupplier, isAuthority, inPnrr, inNgo, hasFinancials }`).
> The contributor registry replaces that with a **per-source open shape**
> (`{ source, present, badges[] }`). This module assumes the kernel ships the
> open `SourcePresence` — it does **not** add an `inNgo` boolean to a fixed
> kernel record. If the kernel keeps a fixed shape, that is a contract conflict
> to resolve in `shared/core/types.ts`, not here.

- **Schema/tables hit:** only `ngo.*` + the kernel schemas (`core` for the CUI
  link, never `flows.money_flows` directly — §4.3).
- **Index notes:** corpus is **~10k profiles** → offset pagination + cheap
  `COUNT(*)` is permitted (§14.4). Driving indexes: `ngo.organizations` unique
  `(cui) WHERE cui IS NOT NULL` (exists in raw, replicate in prod migration);
  `ngo.licenses (cui)`; add `(county_name)`, `(sector)`, `(status)` btree if the
  list filters prove hot. No partitioning — domain is too small.
- **Status timeout class:** all `ngo` reads are 5s (§5.5); aggregates 15s (they
  are still trivially small).

---

## 4. Usecases

> **DEFERRED — pending `ngo` domain.**

| Usecase | Signature | Notes |
|---------|-----------|-------|
| `getNgoProfile` | `(cui) → Result<NgoProfileView | null>` | profile + accreditations + cui-evidence assembled |
| `listNgos` | `(filter, page) → Result<Paged<NgoProfile>>` | name/county/legal_form/sector filters |
| `listAccreditations` | `(filter, page) → Result<Paged<NgoAccreditation>>` | sector/authority/status/validity |
| `ngoCoverage` | `(filter) → Result<NgoBucket[]>` | counts by county/legal_form/sector + **coverage caveat** (corpus is partial) |

**Cross-source contributor (§4.4 / §14.7):**

```ts
export const ngoContributor: SourceContributor = {
  source: 'ngo',
  presenceFor: (cui) => repo.presence(cui).map(p => p && { source: 'ngo', present: p.isNgo, badges: ['ngo', ...p.sectors] }),
  profileSlice: (cui) => /* { kind:'ngo', profile, accreditations[], sectors[] } */,
};
```

- **`flow_type` registered:** *none in v1* (NGO public-money events are
  reference-only / better served by the existing PNRR/procurement flows keyed by
  the NGO's CUI). If/when NGO-native grants land as flows, register
  `ngo_public_money` in `FLOW_TYPES` — **DEFERRED**.
- **`doc_type` registered:** *none in v1* (the corpus is structured rows, not
  free text worth full-text indexing). Optional `ngo_profile` doc_type later for
  name search — **DEFERRED**; until then NGO name search rides the identity-hub
  `searchByName` (§4.1) + Meili entity index, not a dedicated NGO index.

---

## 5. REST endpoints

> **DEFERRED — pending `ngo` domain.** Prefix `/api/v1/ngos/`. All read-only,
> `config: { public: true }` (§14.11), envelope per §5.2, `requestId` included.

| Method | Path | Query (TypeBox) | Response | Pagination | Cache | Timeout |
|--------|------|-----------------|----------|------------|-------|---------|
| GET | `/api/v1/ngos/organizations` | `NgoProfileFilter` (§7) | `NgoProfile[]` | offset (default 1/20, max 100) | 10 min TTL | 5s |
| GET | `/api/v1/ngos/organizations/:cui` | — | `NgoProfileView` (+accreditations+evidence) | — | 10 min TTL | 5s |
| GET | `/api/v1/ngos/accreditations` | `NgoAccreditationFilter` | `NgoAccreditation[]` | offset | 10 min TTL | 5s |
| GET | `/api/v1/ngos/aggregate` | `dim` + `NgoProfileFilter` | `NgoBucket[]` + `{coverage, caveats}` | — | 30 min TTL | 15s |
| GET | `/api/v1/ngos/filters/resolve` | `dim`, `q` | `{value,label}[]` | — | 30 min TTL | 5s |

- `:cui` validated via the kernel `CUI` scalar; `normalizeCui` applied before
  lookup (RO-prefix strip, §4.1).
- Each endpoint contributes an **OpenAPI fragment** merged at
  `/api/v1/openapi.json` (§6.1).
- Detail 404 → `{ ok:false, error:'NotFound', resource:'ngo', message:'...' }`.

---

## 6. GraphQL

> **DEFERRED — pending `ngo` domain.** SDL is final-shapeable now; resolvers wait
> on the repo. Types **domain-prefixed `Ngo*`** (§14.8) — no bare `Profile`/`Status`.

```graphql
# SDL is illustrative target shape; nullability marked contingent on the
# scrapper migration's NOT NULL choices (server is read-only, F5).
type NgoProfile {
  cui: CUI
  name: String        # non-null only if the prod ngo.organizations.name lands NOT NULL
  legalForm: NgoLegalForm
  county: String
  locality: String
  accreditations: [NgoAccreditation!]!
  cuiEvidence: [NgoCuiEvidence!]!
}
type NgoAccreditation {
  sector: String!
  authority: String!
  licenseNo: String
  validFrom: Date
  validTo: Date
  status: String
  active: Boolean     # nullable: null = validity unparseable/unknown (raw valid_* is free text, §13.5)
}
type NgoCuiEvidence {
  source: String!
  evidenceType: String!
  confidence: String!
}
enum NgoLegalForm { ASSOCIATION FOUNDATION FEDERATION SOCIAL_ENTERPRISE OTHER }

type NgoBucket { key: String!, count: Int! }

# coverage-bearing aggregate result — parity with REST §5 + MCP §8 (catalog Core Rule)
type NgoAggregateResult {
  buckets: [NgoBucket!]!
  denominator: Int!
  coverage: NgoCoverage!
  caveats: [String!]!
}
type NgoCoverage { matchedCui: Float! }

input NgoProfileFilter {
  cui: [CUI!]
  name: String
  legalForm: [NgoLegalForm!]
  county: [String!]
  siruta: [SIRUTA!]
  region: [String!]
  sector: [String!]
  status: [String!]
  hasAccreditation: Boolean
  exclude: NgoProfileFilter
}

type NgoProfileConnection { edges: [NgoProfileEdge!]!, pageInfo: PageInfo! }
type NgoProfileEdge { node: NgoProfile!, cursor: String! }

extend type Query {
  ngoProfile(cui: CUI!): NgoProfile
  ngoProfiles(filter: NgoProfileFilter, first: Int, after: String): NgoProfileConnection!
  ngoAggregate(dim: NgoAggregateDim!, filter: NgoProfileFilter): NgoAggregateResult!
}

# Entity join-type extension (§6.2 / §14.7) — resolved via contributor.profileSlice
extend type Entity {
  ngo: NgoEntitySlice           # null when CUI is not an NGO
}
type NgoEntitySlice {
  isNgo: Boolean!
  profile: NgoProfile
  sectors: [String!]!
}
```

> **Tri-surface parity note:** `ngoAggregate` returns `NgoAggregateResult`
> (buckets + `denominator` + `coverage` + `caveats`) so the GraphQL aggregate
> carries the same coverage/denominator that REST §5 and MCP §8 do — no surface
> drops the catalog-mandated coverage fields.

- `Entity.ngo` resolver calls **the same `ngoContributor.profileSlice(cui)`**
  REST entity-360 calls (§14.7), behind a **DataLoader keyed by CUI** (not
  `org_id`, §14.1) to avoid N+1 on entity fan-out.
- List field uses a Relay connection with the **kernel cursor encoder** (§14.3),
  `fhash` parity with REST/MCP. (Offset is the REST default given the tiny
  corpus; the connection still rides the shared cursor for surface parity.)
- Resolvers are thin: parse args → call the core usecase. CI schema-merge
  conflict gate (§14.8) guards the `Ngo*` namespace.

---

## 7. Filters — collection filter spec

> **DEFERRED — pending `ngo` domain** for the *driving columns*, but the spec is
> declared now (the kernel ships the pipeline; this module only declares specs,
> §14.2). One `CollectionFilterSpec` per filterable collection.

### 7.1 `ngo_organizations` filter spec

| Field | Type | Ops | Driving column / index | REST param | GraphQL input | MCP input |
|-------|------|-----|------------------------|------------|---------------|-----------|
| `cui` | string[] | `in` | `ngo.organizations.cui` (unique idx) | `cui` (repeat/CSV) | `cui: [CUI!]` | `cui[]` |
| `name` | string | `contains` (trigram) | `ngo.organizations.normalized_name` (pg_trgm) — **engine: Postgres trigram** (corpus too small for OS) | `q` | `name` | `name` (resolver-first) |
| `legalForm` | enum | `in` | `legal_form` | `legalForm` | `legalForm: [NgoLegalForm!]` | `legalForm[]` |
| `county` | string[] | `in` | `county_name` (+territory hub, §4.2) | `county` | `county` | `county[]` |
| `siruta` | string[] | `in` | via `core.territories` join | `siruta` | `siruta: [SIRUTA!]` | `siruta[]` |
| `region` | string[] | `in` | via `core.territories.region` | `region` | `region` | `region[]` |
| `sector` | string[] | `in` | join `ngo.licenses.sector` (EXISTS) | `sector` | `sector` | `sector[]` |
| `hasAccreditation` | bool | `eq` | EXISTS on `ngo.licenses` | `hasAccreditation` | `hasAccreditation` | `hasAccreditation` |
| `exclude` | nested | — | symmetric negation (`exclude:true` fields only, §14.2) | `exclude.x` | `exclude: NgoProfileFilter` | `exclude{}` |

Sort: default `name` asc; allowed `{name, county, legal_form}`.

### 7.2 `ngo_accreditations` filter spec

| Field | Type | Ops | Driving column | Notes |
|-------|------|-----|----------------|-------|
| `cui` | string[] | `in` | `ngo.licenses.cui` | |
| `sector` | string[] | `in` | `sector` | |
| `authority` | string[] | `in` | `authority` | |
| `status` | enum | `in`,`isNull` | `status` | closed enum after raw value audit |
| `validOn` | date | `lte`/`gte` | `valid_from`/`valid_to` | **text columns in raw** — parse to date in loader, or compile a defensive cast; document the gate |
| `active` | bool | `eq` | derived (`valid_to IS NULL OR valid_to >= now`) | |

- **`q` text engine:** **Postgres trigram** over `normalized_name` (the corpus is
  ~10k rows — Meili/OS are unnecessary; the kernel identity-hub Meili index
  covers cross-domain name autocomplete). Declared per §7.1.
- **`isNull` is mandatory** (§14.2) — coverage questions ("NGOs with no
  accreditation", "profiles missing CUI") need it.

### 7.3 Discovery / resolve dimensions (§7.4)

`/api/v1/ngos/filters/resolve?dim=&q=` exposes: `ngo_name → cui`,
`county → siruta` (via kernel territory hub), `sector` (closed list),
`authority` (closed list), `legal_form` (closed list). Romanian-name → CUI
resolution reuses the kernel discovery infra; the MCP discovery tool wraps it.

### 7.4 Golden question → filter examples (reconciled to the catalog)

The catalog (`AI_AGENT_FILTER_QUESTION_CATALOG.md`) has **no NGO-specific block**;
NGOs surface through **cross-source** questions and as a `kind` dimension. Golden
cases for this module:

| Logical question | Resolved filter | Authoritative source |
|------------------|-----------------|----------------------|
| "Social enterprises in Cluj county" | `legalForm=SOCIAL_ENTERPRISE & county=Cluj` | `ngo.organizations` (native) |
| "Accredited employment-service NGOs, active" | `sector=employment_services & active=true` | `ngo.licenses` (native) |
| "Is CUI X an NGO, and in what sectors?" | `presence(X)` | contributor → entity-360 |
| **XS-1** "Entity 360 for CUI X" (incl. NGO slice) | kernel entity-360 iterates contributors → `ngoContributor` | **kernel** (cross-source) |
| **XS-4** "Company Y: contracts + privacy-safe litigation" | NGO flag is a badge on the entity card | kernel + procurement/justice |
| "How much public money did NGO X receive?" | **NOT NGO-native** — answer from PNRR/procurement/flows keyed by X's CUI | **kernel flows / procurement** (grain gate §14.6); NGO module only flags `isNgo` + lists native `public_money_events` as evidence, never as the authoritative total |

**Coverage caveat (mandatory, §catalog Coverage Gate):** every NGO aggregate
must disclose that the corpus is a **partial presence-signal set** (5 sector
registries + planned ANAF/MJ), not the full ~120k Romanian NGO universe. NGO
counts are **count-weighted only**; "biggest NGO by public money" is answered
via flows/procurement, never via NGO-native data, and labeled.

---

## 8. MCP tools

> **DEFERRED — pending `ngo` domain.** Two families (§6.3): discovery + query.
> Naming `<verb>_<domain>_<noun>`; rate-limited; bounded results; PII-excluded.

| Tool | Input (TypeBox) | Output | Usecase | `link` | Summary template |
|------|-----------------|--------|---------|--------|------------------|
| `resolve_ngo_filters` (discovery) | `{ dim: 'ngo_name'|'county'|'sector'|'authority'|'legal_form', q }` | `{ ok, kind:'resolution', items:[{value,label,cui?}] }` | shared resolve | `/ngos?…` | "Resolved '{q}' → {n} candidates." |
| `get_ngo_profile` (query) | `{ cui: CUI }` | `{ ok, kind:'ngo_profile', item: NgoProfileView, link, summary }` | `getNgoProfile` | `/ngos/{cui}` | "{name} ({legalForm}) in {county}; {n} accreditations across {sectors}." |
| `list_ngos` (query) | `NgoProfileFilter + page` | `{ ok, kind:'ngo_list', items, summary }` | `listNgos` | `/ngos?…` | "{total} NGOs matching {filters} (coverage: partial)." |
| `aggregate_ngos` (query) | `{ dim, NgoProfileFilter }` | `{ ok, kind:'ngo_aggregate', items:[{key,count}], coverage, caveats }` | `ngoCoverage` | `/ngos/aggregate?…` | "By {dim}: top {k}; coverage {pct}% — partial corpus." |

- MCP filter inputs are **the same fields as REST** (§7.3); the discovery tool
  resolves names → CUI/codes first, then the query tool runs deterministic SQL
  (catalog LLM-safety gate: LLM never invents CUIs/counts).
- Every aggregate output carries `coverage` + `caveats` + `denominator` per the
  catalog Core Rule.

---

## 9. Search integration

> **DEFERRED — pending `ngo` domain.**

- **`doc_type` owned in v1:** **none.** The NGO corpus is structured rows;
  full-text indexing adds little. NGO **name autocomplete** rides the kernel
  identity-hub Meili index once `core.organizations` carries `kind='ngo'` rows
  (prerequisite §1.4.3) — no dedicated NGO Meili/OS index in v1.
- **Optional later:** an `ngo_profile` doc_type projecting `{name, legal_form,
  sectors, county}` into `search.documents` if NGO discovery demand grows. The
  scrapper `search` lane writes it; the server only reads. **DEFERRED.**
- **Semantic/pgvector:** capability-gated (§14.5) — not applicable to the
  structured NGO corpus; no semantic fields exposed.

---

## 10. Sync / freshness impact on serving

> **DEFERRED — pending `ngo` domain** for exact cadence; design below.

- **Cadence:** the source registries refresh **slowly** (annual-ish XLSX
  re-publication; ANOFM/FPA/ARACIP). Loader cadence **monthly** is ample; NGO
  data is near-static between loads.
- **Mutability:** accreditation **status/validity** changes (license expiry,
  revocation) — these are **updates, not appends**; the loader upserts on
  `license_key` (raw lane already does `ON CONFLICT (license_key) DO UPDATE`).
  Profiles upsert on `profile_key`/`cui`.
- **Cache:** TTL 10–30 min is fine given the near-static data; add a per-domain
  loader-completion version stamp from `system_control` (§14.11) as the "as-of"
  watermark surfaced on reads. If no signal exists at first wiring, TTL-only is
  the documented interim.

---

## 11. Wiring

> **DEFERRED — pending `ngo` domain** (module ships disabled until then).

```ts
// ngo/index.ts
export const makeNgoModule = (deps: { db: Kysely<ProdDatabase>; cache: Cache }): NgoModule => ({
  restPlugin, graphql: { typeDefs, resolvers }, mcpTools, contributor: ngoContributor, repos: { ngoRepo },
});
```

- **`build-app.ts`:** construct after the kernel + companies; register REST
  (`/api/v1/ngos`), merge GraphQL slice, register MCP tools, **register
  `ngoContributor`** into the kernel registry (this is the only cross-source
  hook — entity-360 picks NGOs up automatically, §4.4).
- **Env:** no new external services. Gate enablement behind the module feature
  flag (off until the `ngo` schema exists); reads `PROD_DATABASE_URL` only.
- **Legacy superseded:** the old `unified` `makeUnifiedNgoRepo` /
  `UnifiedNgoRepository` (on `feat/unified-explorer`) and the `ngoProfile`/
  `ngoLicenses` fields of the monolithic `Entity360`. This module replaces them
  with the contributor pattern.

---

## 12. Testing

> Unit tests are writable now (mocked ports); integration tests gate on the
> `ngo` schema existing.

- **Unit (`tests/unit/ngo/`):** usecases with mocked `NgoRepository`; filter
  spec → SQL compilation snapshots (`ngo_organizations`, `ngo_accreditations`),
  incl. `isNull`/`exclude`; cursor encode/decode `fhash` parity; `normalizeCui`
  on `:cui`; **privacy test** — assert the repo row type and every projection
  **structurally exclude** contact/person columns (no path can emit them).
- **Integration (`tests/integration/ngo/`, gated):** REST + GraphQL + MCP return
  equivalent data for equivalent filters (canonicalizeFilters parity); 404 on
  unknown CUI; `Entity.ngo` resolver === `ngoContributor.profileSlice`.
- **Golden filters:** the §7.4 table as integration cases, each asserting the
  mandatory `coverage`/`caveats` on aggregates and that "biggest by public
  money" is **refused/redirected** to flows (catalog gates).

---

## 13. Open questions / risks

1. **(BLOCKER) No `ngo` domain in serving.** Entire module is gated on the
   scrapper landing `ngo.*` + `kind='ngo'` in `core.organizations` (§1.4). Until
   then this is a paper module. — *needs scrapper slice (TRACKER #9).*
2. **Identity-hub linkage decision (architecture).** Should NGO CUIs become
   `core.organizations` rows with `kind='ngo'`, or stay NGO-schema-local with a
   CUI FK and NGO-ness derived at query time? The contract says "link-not-merge,
   never reassign org_id." **Collision risk:** many NGO CUIs (esp. social
   enterprises) already exist as `company`-kind rows (the hub holds 3.98M
   company rows), so a blind `kind='ngo'` upsert would *overwrite* the company
   kind — a merge-by-mutation §4.1 forbids. **Recommendation:** treat NGO-ness as
   an **additive identifier/badge**, not a `kind` reassignment — either (a) make
   `kind` multi-valued (an array or a `kinds` overlay column) so a CUI can be both
   `company` and `ngo`, or (b) insert `kind='ngo'` rows **only for CUIs not
   already present**, and for already-present CUIs add a `core.organization_identifiers`
   row (`scheme='ngo_registry'`) / an `attrs.is_ngo` flag instead. Entity-360
   keys on CUI regardless, so the badge works either way. **Needs a
   user/architecture decision** before the scrapper migration.
3. **Coverage honesty.** The corpus (~10k profiles, 5 registries) is a tiny,
   biased slice of Romania's ~120k NGOs. Every count/aggregate MUST carry a
   partial-coverage caveat; "largest NGO" / "total NGO public money" answers
   come from flows/procurement, never NGO-native data (grain gate §14.6).
4. **ANAF/MJ enrichment timing.** Fiscal status, financials, deductible status,
   and the MJ legal-identity backbone are research-ready but **not loaded**;
   `ngo.fiscal_status`/`ngo.financials` and MJ registration numbers are DEFERRED.
   The MJ backbone is the path to a *real* NGO registry — flag as the highest-
   value next scrapper step for this source.
5. **Validity columns are text in raw.** `valid_from`/`valid_to`/`status` are
   free-text; the `active` derivation and `validOn` filter depend on the loader
   normalizing them (or a defensive cast). Document the parse gate.
6. **No flow_type / doc_type in v1.** NGO public-money is reference-only; if the
   product wants NGO-native flow totals later, that is a scrapper `flows` lane
   addition + a `FLOW_TYPES` enum entry — DEFERRED, not in scope here.
