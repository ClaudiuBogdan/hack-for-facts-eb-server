# 06 — Monitorul Oficial (the `legal` module gazette surface)

> **Status:** plan. Conforms to `00-foundation-shared-kernel.md` (binding). This
> module **co-owns** `src/modules/legal/` with portal-legislativ (05). Per
> foundation §9, **portal owns the `legal` module skeleton + the `LegalAct` base
> type; MO EXTENDS it** with the official-gazette surface and uses the `Mo*`
> GraphQL prefix. This plan does **not** redefine the module index or `LegalAct`.
>
> **Scope owned by MO (this plan):** `legal.mo_issues`, `legal.mo_act_publications`,
> `legal.mo_lifecycle_edges`, and the MO-written rows of `legal.act_status_events`
> (`event_source = 'monitorul-oficial'`). Surfaces: gazette **issue browsing**,
> **act-publication lookup**, **lifecycle/status timelines** (promulgare/aprobare/
> rectificare/republicare/respinge), and the **consumer side** of the
> act↔gazette correlation (`mo_part`/`mo_number`/`mo_date`).

---

## §0. Assumptions about the portal (05) skeleton — for orchestrator reconciliation

Plan 05 did not exist when this plan was written; the items below are what MO
**expects** 05 to define. The consistency pass reconciles them. If any differs,
only the named symbol changes — MO's owned surface is unaffected.

- **A1 — module index.** Portal defines `src/modules/legal/index.ts` exporting
  `makeLegalModule(deps): LegalModule` returning `{ restPlugin, graphql:{typeDefs,
resolvers}, mcpTools, contributor, repos }`. **MO contributes** a sub-factory
  `makeMonitorulSurface(deps): { restRoutes, typeDefs, resolvers, mcpTools,
entityExtension }` that portal's `makeLegalModule` composes into the single
  module export. (One module, one REST plugin prefix `/api/v1/legal`, one GraphQL
  slice, one MCP namespace — MO does not register a second module.)
- **A2 — `LegalAct` base type + `act_id` scalar.** Portal owns `type LegalAct`
  keyed on `legal.acts.act_id` (`BigInt`→string). MO **references** it
  (`MoActPublication.act: LegalAct`) and **extends** it with the 3-field gazette
  set (`extend type LegalAct { gazettePublications: [MoActPublication!]!
gazetteStatusEvents: [MoStatusEvent!]!  gazetteInEdges: [MoLifecycleEdge!]! }`,
  the authoritative naming — see §6 and foundation §9). MO never declares
  `type LegalAct`.
- **A3 — shared legal repo base.** Portal defines a `LegalRepoBase` (the typed
  Kysely instance + `legal.acts` row mapper + `act_id` resolution helpers). MO's
  `MonitorulRepo` reuses the act mapper to hydrate `act` on publications without
  re-implementing it.
- **A4 — shared legal filter families.** Portal owns the `act_type`, `issuer`
  (`issuer_slug`), `domain`, `year` filter field specs (foundation §9). MO
  **reuses** those specs verbatim on its collections (publications carry
  `act_type`, `issuer_slug`, `act_year`) and adds MO-only fields (`part_code`,
  `resolution`, `relation`, `issue_year`, `issue_date`).
- **A5 — `Entity` extension key.** Portal and MO both extend the kernel `Entity`
  join type independently via the contributor registry (§4.4/§14.7). MO's
  `Entity` extension is **issuer-keyed** (an organization that is an MO issuer,
  matched by `issuer_slug`, since MO publications carry no CUI — see §4.4).
- **A6 — `act_status_events` writer split.** Confirmed live: the table carries
  `event_source` (`not null default 'portal'`); the natural unique index leads
  with `(act_id, event_kind, …, event_source)`. MO **reads only**
  `event_source='monitorul-oficial'` rows; portal reads its own. No server
  writes either way (foundation F5).

If 05 instead makes `legal` a true two-factory module (portal-index + mo-index
both mounted), MO's surface is unchanged — only the wiring in §11 collapses.

---

## §1. Summary & data status

The Official Gazette is the **publication-evidence layer** of `transparenta_prod`:
where/when each act was published, the lifecycle edges only MO can ground, and
the **MO-only long tail** (~84K ministerial orders / agency decisions / BNR
circulars) that portal does not carry. Source-of-truth doc set:
`prod-db/MONITORUL_NOTES.md`, `BRIEF_MONITORUL_SCHEMA.md`,
`MONITORUL_DECISION_REVIEW.md`.

**In prod now (measured, `MONITORUL_NOTES.md` loader run 2026-06-12, A8 + recovery):**

| Table                               | Rows        | Grain                  | Notes                                                                                                                                                     |
| ----------------------------------- | ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legal.mo_issues`                   | **42,173**  | one gazette issue      | both raw lanes merged on `(part_code, lower(issue_label), issue_year)`; `has_emonitor_link` carries PDF/S3; 2012–2019 archive hole remains until backfill |
| `legal.mo_act_publications`         | **148,856** | one publication event  | `act_id` nullable (link-not-merge); `resolution ∈ {unique, ambiguous, unmatched}`                                                                         |
| `legal.mo_lifecycle_edges`          | **20,897**  | one lifecycle relation | `relation ∈ {promulga, aproba, respinge, rectifica, republica}`; resolves into both act-id plane and MO-local plane                                       |
| `legal.act_status_events` (MO rows) | **9,473**   | one status event       | `event_source='monitorul-oficial'`; kinds `promulgare`/`aprobare-oug`/`aprobare-og`/`rectificare`/`republicare`                                           |

Edge distribution (NOTES): promulga 6,853 unique / 648 mo-only / 254 unresolved
(96.7% paired); aproba 2,132 unique; respinge 169 unique; republica 293 unique /
1,325 mo-only. Publication resolution: lege resolution 0.9115, ambiguous 0.31%,
`unique_without_act_id` 0; semantic-dup 10 (warn-tier).

**Coverage honesty (must be surfaced per-year, never silent empties):** archive
metadata 1990–2010 + 2021–2026 (until the 2011–2020 backfill lands); full-text
extraction era 2012–2026 (MO-B); the 2024–2026 Part I PDF gap is recovered;
Part II / pre-2012 OCR deferred. Every list/aggregate response declares a
`coverage` block (per AI_AGENT_FILTER_QUESTION_CATALOG "Core Rule").

**Deferred (NOT in this plan's serving surface — MO-B/MO-C raw layer):**
the `monitorul_oficial_extracted` raw layer (4 tables: `extractor_versions`,
`extraction_queue`, `issue_extractions`, `sections`) lives in the **raw**
cluster, not `transparenta_prod`. The server reads it only **indirectly** via the
scrapper `search` lane's `mo_section` / `mo_section_metadata` projection into
`search.documents` (§9). MO's serving repo touches **only** `legal.mo_*`,
`legal.act_status_events`, `legal.acts` (read), `search.documents` (read via
kernel), and the kernel `core`/`flows` schemas. **No full-text-section repo in
v1** — full-text MO retrieval is search-engine-backed (§9), capability-gated.

**Prod schema(s) touched:** `legal` (own `mo_*` + read `acts`, `act_status_events`),
`search` (read, via kernel SearchRepo), `core` (read, via kernel IdentityRepo for
issuer resolution).

---

## §2. Schema → domain model

Table-by-table mapping to `legal/core/types.ts` view models. All scalars per
foundation §14.1 (`bigint`→`string`, `numeric`→`string`, dates `YYYY-MM-DD`).
No PII columns exist in `mo_*` (gazette text is public; PII concerns are in the
deferred MO-B extracted layer, not here).

### 2.1 `legal.mo_issues` → `MoIssue`

```ts
// legal/core/types.ts (MO section)
export interface MoIssue {
  readonly moIssueId: string; // bigint → string
  readonly partCode: MoPartCode; // 'PI'|'PII'|'PIM'|'PIII'|'PIV'|'PV'|'PVI'|'PVII'
  readonly moPart: number | null; // generated stored col; PIM → null (no portal citation form)
  readonly issueLabel: string; // e.g. '123', '123bis'
  readonly issueNumber: number | null;
  readonly issueSuffix: string; // '' default; 'bis'/'Bis'
  readonly issueYear: number; // smallint
  readonly issueDate: string | null; // date
  readonly pdfUrl: string | null;
  readonly hasArchiveIndex: boolean;
  readonly hasEmonitorLink: boolean;
  readonly pdfBytes: string | null; // bigint → string
  readonly firstSeenAt: string; // ISO
  readonly lastSeenAt: string;
  // s3_bucket / s3_key / pdf_sha256 → INTERNAL, excluded from default projection (§2.5)
}
```

### 2.2 `legal.mo_act_publications` → `MoActPublication`

```ts
export interface MoActPublication {
  readonly moActKey: string; // PK (content-derived sha256; opaque to clients)
  readonly moIssueId: string | null; // bigint → string
  readonly actType: string | null; // loader-rederived (lege-first/anchored)
  readonly actNumberNorm: string | null; // via shared normalizeActNumber
  readonly actYear: number | null;
  readonly issueYear: number | null;
  readonly issuerSlug: string | null; // '' for national types; via shared issuerSlug
  readonly title: string | null;
  readonly actDate: string | null;
  readonly actId: string | null; // bigint → string; null when link-not-merge unresolved
  readonly resolution: 'unique' | 'ambiguous' | 'unmatched';
  readonly matchedVia: 'act-year' | 'issue-year' | null;
  readonly sourcePdfUrl: string | null; // evidence only
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  // raw fields (act_type_raw/act_number_raw/issuer_raw) → EVIDENCE-ONLY, excluded
  //   from default projection; available via ?include=raw (§5) for audit.
}
```

`act` (the `LegalAct` it resolves to, when `actId != null`) is hydrated lazily by
the GraphQL resolver / a `?expand=act` REST flag through portal's act mapper (A3).

### 2.3 `legal.mo_lifecycle_edges` → `MoLifecycleEdge`

```ts
export interface MoLifecycleEdge {
  readonly edgeId: string;
  readonly sourceMoActKey: string; // FK → mo_act_publications
  readonly relation: 'promulga' | 'aproba' | 'respinge' | 'rectifica' | 'republica';
  readonly targetRaw: string; // per-target normalized citation fragment
  readonly targetIndex: number;
  readonly targetActType: string | null;
  readonly targetActNumber: string | null;
  readonly targetActYear: number | null;
  readonly targetIssuerSlug: string;
  readonly targetActId: string | null; // identity plane (when citation key resolves)
  readonly targetMoActKey: string | null; // MO-local plane (mo-only targets)
  readonly resolution: 'unique' | 'mo-only' | 'ambiguous' | 'unresolved';
  readonly matchedVia: 'act-year' | 'issue-year' | null;
  readonly method: string;
  readonly confidence: number | null; // real
  // evidence jsonb → exposed only on the edge-detail/lookup endpoint, not lists
}
```

### 2.4 `legal.act_status_events` (MO rows) → `MoStatusEvent`

MO is the **consumer** of `event_source='monitorul-oficial'` rows. Distinct from
the portal `LegalAct.status` fold (that remains portal-evidence-derived;
NOTES "Contract fixes" #3). MO status events are **queryable lifecycle evidence**.

```ts
export interface MoStatusEvent {
  readonly eventId: string;
  readonly actId: string; // not null; FK → legal.acts
  readonly eventKind: 'promulgare' | 'aprobare-oug' | 'aprobare-og' | 'rectificare' | 'republicare';
  readonly effectiveDate: string | null;
  readonly sourceActId: string | null; // the act asserting the event (e.g. the decret)
  readonly eventSource: 'monitorul-oficial';
  // evidence jsonb → exposed on detail only
}
```

> **Constraint note (reviewer B2/B1).** The live `act_status_events_kind_check`
> allows **12** values; the 5-value closed set above is what **MO writes**, not a
> DB constraint — it is enforced by the MO loader's `RESOLVER_VERSION`, not the
> CHECK. The repo MUST therefore (a) always filter `event_source='monitorul-oficial'`
> (the only safe discriminator — `rectificare`/`republicare` are also portal-native
> kinds, see `20260612T220000` `down`), and (b) treat an out-of-set kind as a
> serialization guard (map unknown → drop + log, never throw). **`respinge` is NOT
> a status event** — it is edge-only (`mo_lifecycle_edges.relation='respinge'`,
> migration line 53). So "rejection" counts come from **edges**, never from
> `MoStatusEvent` (fixes the §8.3 summary source — see §8.3).

### 2.5 Identity / territory linkage; excluded columns

- **CUI / identity:** MO publications carry **no CUI** (gazette acts are not
  organizations). The identity link is **issuer-slug → organization** (best-effort,
  via the kernel IdentityRepo `searchByName`/a slug→org map), used only for the
  `Entity` extension (§4.4) and issuer discovery (§7.4). It is **never** a hard
  join in list queries.
- **Territory (SIRUTA):** none — gazette issues are national. No `GeographicFilter`
  on MO collections (declared absent in §7).
- **Excluded from default projections (enumerated, foundation §8.2):**
  `mo_issues.{s3_bucket, s3_key, pdf_sha256}` (storage-internal),
  `mo_act_publications.{act_type_raw, act_number_raw, issuer_raw}` (evidence-only,
  opt-in via `?include=raw`), `mo_lifecycle_edges.evidence` and
  `act_status_events.evidence` (jsonb, detail-only). No privacy-flagged columns
  exist in MO's owned tables.

---

## §3. Repo interface (ports)

`legal/core/ports.ts` — MO contributes one repo interface (composed alongside
portal's). All methods return `Result<T, ApiError>` (neverthrow). It touches
**only** `legal.mo_*` + `legal.act_status_events` + `legal.acts` (read) + the
kernel SearchRepo (injected, not a direct `search.*` read).

```ts
export interface MonitorulRepo {
  // ── issue browsing ─────────────────────────────────────────────────────────
  getIssueById(moIssueId: string): Promise<Result<MoIssue | null, ApiError>>;
  // resolve a portal mo_part/mo_number/mo_date triple to an issue (consumer side
  // of the act↔gazette correlation contract). Takes part_code (text) — the
  // caller maps portal's mo_part(int) → part_code; PIM has no int form and is
  // unresolvable by this route (reviewer S1):
  findIssueByCoordinates(
    partCode: MoPartCode,
    moNumberText: string,
    moDate: string | null
  ): Promise<Result<MoIssue | null, ApiError>>; // §2.1 conversion rule
  listIssues(
    f: MoIssueFilterInput,
    page: OffsetPage,
    sort: MoIssueSort
  ): Promise<Result<Paged<MoIssue>, ApiError>>; // offset (bounded by year)
  getIssueContents( // table-of-contents
    moIssueId: string,
    page: OffsetPage
  ): Promise<Result<Paged<MoActPublication>, ApiError>>;

  // ── act-publication lookup ───────────────────────────────────────────────────
  getPublicationByKey(moActKey: string): Promise<Result<MoActPublication | null, ApiError>>;
  listPublications(
    f: MoPublicationFilterInput,
    cursor: CursorArg,
    sort: MoPublicationSort
  ): Promise<Result<Cursored<MoActPublication>, ApiError>>;
  // MO-4 / consumer correlation: every place an act was published:
  getPublicationsForAct(actId: string): Promise<Result<readonly MoActPublication[], ApiError>>;
  countPublicationsByIssuerYear( // MO-1 aggregate
    f: MoPublicationAggInput
  ): Promise<Result<readonly MoIssuerYearCount[], ApiError>>;

  // ── lifecycle / status timelines ─────────────────────────────────────────────
  getEdgesForSource(moActKey: string): Promise<Result<readonly MoLifecycleEdge[], ApiError>>;
  getEdgesForTargetAct(actId: string): Promise<Result<readonly MoLifecycleEdge[], ApiError>>; // LG-2/MO-3 (in-edges)
  listEdges(
    f: MoEdgeFilterInput,
    cursor: CursorArg
  ): Promise<Result<Cursored<MoLifecycleEdge>, ApiError>>;
  getStatusEventsForAct(actId: string): Promise<Result<readonly MoStatusEvent[], ApiError>>; // LG-3 (MO evidence slice)

  // ── Entity / contributor support (issuer-keyed; §4.4) ────────────────────────
  countPublicationsByIssuerSlug(
    issuerSlug: string
  ): Promise<Result<MoIssuerSummary | null, ApiError>>;
  resolveIssuer(q: string, limit: number): Promise<Result<readonly MoIssuerHit[], ApiError>>; // discovery (§7.4)
}
```

**Schema / index notes per method (verified against live `pg_indexes`, §recon):**

| Method                                            | Driving table         | Driving index / predicate                                                                                                                                                                                                                                                                                                                                                          | Notes                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getIssueById`                                    | `mo_issues`           | `mo_issues_pkey (mo_issue_id)`                                                                                                                                                                                                                                                                                                                                                     | point lookup                                                                                                                                                                                               |
| `findIssueByCoordinates`                          | `mo_issues`           | `mo_issues_identity_uq (part_code, lower(issue_label), issue_year)`                                                                                                                                                                                                                                                                                                                | conversion rule §2.1; caller passes `part_code` (portal `mo_part`→`part_code`; PIM unresolvable), then `lower(regexp_replace(mo_number,'\s+','','g')) = lower(issue_label)`, year via `mo_date`/`act_year` |
| `listIssues`                                      | `mo_issues`           | ⚠ **earned index needed** — no `(issue_year, issue_date, part_code)` index exists today (only PK + identity_uq). v1 bounds the scan by **mandatory `year`** (table is 42K rows, full filtered scan is cheap; offset OK) and declares the index as a measured-workload follow-up (§13 R3).                                                                                          |
| `getIssueContents`                                | `mo_act_publications` | `mo_act_publications_issue_idx (mo_issue_id)`                                                                                                                                                                                                                                                                                                                                      | TOC; the index's documented consumer                                                                                                                                                                       |
| `getPublicationByKey`                             | `mo_act_publications` | `mo_act_publications_pkey (mo_act_key)`                                                                                                                                                                                                                                                                                                                                            | point lookup                                                                                                                                                                                               |
| `listPublications`                                | `mo_act_publications` | ⚠ **no single covering index** — filters are `act_type`/`issuer_slug`/`act_year`/`resolution`. v1 requires **at least one bounding predicate** (`act_year` OR `issuer_slug` OR `mo_issue_id`); cursor-paginated on `(act_year desc, mo_act_key)`. 148K rows; an earned composite index `(act_year, act_type, issuer_slug)` is the §13 R3 follow-up if name+year scans show up hot. |
| `getPublicationsForAct`                           | `mo_act_publications` | `mo_act_publications_act_idx (act_id) WHERE act_id IS NOT NULL`                                                                                                                                                                                                                                                                                                                    | MO-4; the partial index's purpose                                                                                                                                                                          |
| `countPublicationsByIssuerYear`                   | `mo_act_publications` | grouped scan bounded by `issue_year`/`act_year`+`issuer_slug`                                                                                                                                                                                                                                                                                                                      | MO-1 aggregate; 15s class                                                                                                                                                                                  |
| `getEdgesForSource`                               | `mo_lifecycle_edges`  | `mo_lifecycle_edges_natural_uq` prefix `(source_mo_act_key, …)`                                                                                                                                                                                                                                                                                                                    | out-edges of a publication                                                                                                                                                                                 |
| `getEdgesForTargetAct`                            | `mo_lifecycle_edges`  | `mo_lifecycle_edges_target_act_idx (target_act_id) WHERE NOT NULL`                                                                                                                                                                                                                                                                                                                 | LG-2/MO-3 in-edges                                                                                                                                                                                         |
| `listEdges`                                       | `mo_lifecycle_edges`  | bounded by `relation` and/or `target_act_id`; cursor on `(edge_id)`                                                                                                                                                                                                                                                                                                                |                                                                                                                                                                                                            |
| `getStatusEventsForAct`                           | `act_status_events`   | `act_status_events_natural_uq` **prefix** `(act_id, event_kind, …)` + WHERE `event_source='monitorul-oficial'`                                                                                                                                                                                                                                                                     | the leading-column prefix serves the act lookup; **no dedicated `act_id` index needed**                                                                                                                    |
| `countPublicationsByIssuerSlug` / `resolveIssuer` | `mo_act_publications` | grouped scan on `issuer_slug` (⚠ no index; bounded/cached — 367 distinct slugs, cache-friendly)                                                                                                                                                                                                                                                                                    | discovery; cached, TTL long                                                                                                                                                                                |

**No write path** (foundation F5). All reads via `selectFrom`/`with`/parameterized
`sql`. `act_id`/`mo_issue_id`/`pdf_bytes` are read with the int8→string pg parser
already configured by the kernel (§14.1).

---

## §4. Usecases

`legal/core/usecases/` (MO section). Framework-free; each calls one repo method,
shapes the view model, attaches `coverage`/`caveats` where the catalog requires it.

| Usecase               | Signature                                                               | Repo                                             | Notes                                    |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| `getIssue`            | `(id) → Result<MoIssueView, ApiError>`                                  | `getIssueById` + `getIssueContents` (TOC, opt)   | NotFound if absent                       |
| `browseIssues`        | `(filter, page, sort) → Result<Paged<MoIssue>, ApiError>`               | `listIssues`                                     | requires `year`; coverage block per-year |
| `lookupPublication`   | `(moActKey) → Result<MoActPublicationView, ApiError>`                   | `getPublicationByKey` (+ optional `act` expand)  |                                          |
| `listPublications`    | `(filter, cursor, sort) → Result<Cursored<MoActPublication>, ApiError>` | `listPublications`                               | bounding predicate enforced              |
| `wherePublished`      | `(actId) → Result<MoPublicationEvents, ApiError>`                       | `getPublicationsForAct`                          | **MO-4** answer                          |
| `issuerYearBreakdown` | `(issuerSlug?, year, subtype?) → Result<Agg+coverage, ApiError>`        | `countPublicationsByIssuerYear`                  | **MO-1** answer; deterministic count     |
| `actLifecycle`        | `(actId) → Result<{ inEdges, outEdges, statusEvents }, ApiError>`       | `getEdgesForTargetAct` + `getStatusEventsForAct` | **MO-3/LG-2** MO slice                   |
| `edgeList`            | `(filter, cursor) → Result<Cursored<MoLifecycleEdge>, ApiError>`        | `listEdges`                                      |                                          |
| `resolveIssuer`       | `(q, limit) → Result<readonly MoIssuerHit[], ApiError>`                 | `resolveIssuer`                                  | discovery (§7.4)                         |

**Cross-source contributor (foundation §4.4/§14.7).** MO registers a
`SourceContributor` with `source: 'monitorul-oficial'`. Because MO has **no CUI**,
its contributor is **issuer-keyed**, resolved through the kernel identity hub:

```ts
presenceFor(cui): // resolve cui → org name → issuer_slug candidates → countPublicationsByIssuerSlug
  Promise<Result<SourcePresence | null, ApiError>>;   // { source:'monitorul-oficial', count, lastDate } or null
profileSlice(cui): // same path → MoIssuerSummary { publicationCount, byPartCode, lastIssueDate, topActTypes }
  Promise<Result<EntityProfileSlice | null, ApiError>>;
```

This powers `Entity.monitorul` in GraphQL (§6) **via the same `profileSlice`
usecase** that REST entity-360 calls (§14.7). The match is best-effort and labels
its confidence; it is **never** asserted as a CUI-grade link.

- **`flow_type` registered:** **none.** MO has no money flows (gazette publications
  are not transfers). MO does **not** read `flows.money_flows`.
- **`doc_type`(s) registered:** `mo_act` (deterministic metadata, MO-A backbone) —
  see §9 for the contract-name reconciliation.

---

## §5. REST endpoints

Prefix `/api/v1/legal/` (shared with portal; MO owns the `mo-*` sub-paths). Every
route `config: { public: true }` (§14.11). TypeBox at the boundary; envelope per
§5.2 + `requestId`. Statement-timeout classes: read 5s, aggregate 15s.

| Method | Path                                   | Query / params (TypeBox)                                                                                                                                               | Response                                                                     | Pagination                              | Cache  | Timeout |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- | ------ | ------- |
| GET    | `/legal/mo-issues`                     | `MoIssueFilter` (§7.1): `year`(req), `partCode[]`, `dateFrom/To`, `hasPdf`, `q`; `page`,`pageSize`(≤100), `sort`                                                       | `MoIssue[]` + `meta.page{page,pageSize,total}` + `coverage`                  | offset (bounded by `year`, cheap count) | 10 min | 5s      |
| GET    | `/legal/mo-issues/:moIssueId`          | path id; `?contents=true`                                                                                                                                              | `MoIssue` (+ `contents: MoActPublication[]` first page)                      | —                                       | 10 min | 5s      |
| GET    | `/legal/mo-issues/:moIssueId/contents` | path id; `page`,`pageSize`                                                                                                                                             | `MoActPublication[]` (TOC) + `meta.page`                                     | offset                                  | 10 min | 5s      |
| GET    | `/legal/mo-publications`               | `MoPublicationFilter` (§7.1): `actType[]`,`issuerSlug[]`,`actYear`,`issueYear`,`resolution[]`,`actId`,`q`; `cursor`,`limit`(≤100),`sort`; `?include=raw`,`?expand=act` | `MoActPublication[]` + `meta.cursor{next}` + `coverage`                      | cursor `(act_year desc, mo_act_key)`    | 5 min  | 5s      |
| GET    | `/legal/mo-publications/:moActKey`     | path key; `?include=raw`,`?expand=act`                                                                                                                                 | `MoActPublication` (+ `act?: LegalAct`)                                      | —                                       | 10 min | 5s      |
| GET    | `/legal/acts/:actId/publications`      | path actId                                                                                                                                                             | `{ act: {actId}, publications: MoActPublication[] }`                         | — (bounded ≤ ~dozens)                   | 10 min | 5s      |
| GET    | `/legal/acts/:actId/gazette-timeline`  | path actId                                                                                                                                                             | `{ statusEvents: MoStatusEvent[], inEdges: MoLifecycleEdge[] }` + `coverage` | —                                       | 10 min | 5s      |
| GET    | `/legal/mo-edges`                      | `MoEdgeFilter` (§7.1): `relation[]`,`resolution[]`,`sourceMoActKey`,`targetActId`; `cursor`,`limit`                                                                    | `MoLifecycleEdge[]` + `meta.cursor`                                          | cursor `(edge_id)`                      | 5 min  | 5s      |
| GET    | `/legal/mo-publications/aggregate`     | `MoPublicationAggFilter`: `issuerSlug`,`year`(req),`actType[]`,`groupBy`(enum: `issuer`\|`act_type`\|`year`)                                                           | `MoIssuerYearCount[]` + `denominator` + `coverage`                           | offset (small)                          | 10 min | 15s     |
| GET    | `/legal/filters/resolve`               | `dim`(enum: `mo_issuer`\|`mo_part`\|`mo_act_type`), `q`, `limit`                                                                                                       | `{ dim, matches: [{value,label,count}] }`                                    | —                                       | 30 min | 5s      |

**OpenAPI notes:** MO exports an OpenAPI fragment (paths above + the `Mo*` component
schemas derived from the TypeBox specs); the kernel merges it into
`/api/v1/openapi.json`. Component schema names are `Mo`-prefixed to avoid collision
with portal's `LegalAct*` schemas. The act↔gazette **producer** routes
(`/legal/acts/:id` detail with `mo_part/mo_number/mo_date` fields) belong to portal
(05); MO owns the **consumer** routes above (`/acts/:id/publications`,
`/acts/:id/gazette-timeline`) — orchestrator confirms no path collision.

**`coverage` block (catalog Core Rule)** on every list/aggregate response,
**scoped per collection** (reviewer S5 — `mo_issues` has no `resolution`
dimension): `{ years: {min,max}, per_year_present: {...}, gaps: ['2012-2019
archive hole','Part II deferred'], resolutionRates?: {unique, ambiguous,
unmatched} }`. `resolutionRates` is present only on **publication/edge**
collections; **omitted (null) for `mo_issues`** browse responses.

---

## §6. GraphQL

MO **extends** the portal-owned `legal` GraphQL slice; all MO types are `Mo*`
(foundation §14.8). MO never declares `type LegalAct` (A2).

```graphql
# ── MO object types (Mo* prefix) ──────────────────────────────────────────────
enum MoPartCode {
  PI
  PII
  PIM
  PIII
  PIV
  PV
  PVI
  PVII
}
enum MoResolution {
  unique
  ambiguous
  unmatched
}
enum MoEdgeResolution {
  unique
  mo_only
  ambiguous
  unresolved
} # mo_only ↔ DB 'mo-only' (§6.1)
enum MoRelation {
  promulga
  aproba
  respinge
  rectifica
  republica
}
enum MoStatusKind {
  promulgare
  aprobare_oug
  aprobare_og
  rectificare
  republicare
} # underscores ↔ DB hyphens (§6.1)
enum MoMatchedVia {
  act_year
  issue_year
} # act_year ↔ DB 'act-year' (§6.1)
enum MoIssueSort {
  ISSUE_DATE_DESC
  ISSUE_DATE_ASC
  ISSUE_YEAR_DESC
}
enum MoPublicationSort {
  ACT_YEAR_DESC
  ACT_YEAR_ASC
}

type MoIssue {
  moIssueId: BigInt!
  partCode: MoPartCode!
  moPart: Int
  issueLabel: String!
  issueNumber: Int
  issueSuffix: String!
  issueYear: Int!
  issueDate: Date
  pdfUrl: String
  hasArchiveIndex: Boolean!
  hasEmonitorLink: Boolean!
  pdfBytes: BigInt
  firstSeenAt: DateTime!
  lastSeenAt: DateTime!
  contents(first: Int = 20, after: String): MoActPublicationConnection! # TOC, DataLoader by mo_issue_id
}

type MoActPublication {
  moActKey: ID!
  moIssueId: BigInt
  issue: MoIssue # DataLoader by mo_issue_id
  actType: String
  actNumberNorm: String
  actYear: Int
  issueYear: Int
  issuerSlug: String
  title: String
  actDate: Date
  actId: BigInt
  act: LegalAct # portal type (A2); DataLoader by act_id, null when unresolved
  resolution: MoResolution!
  matchedVia: MoMatchedVia # enum, value-translated (§6.1)
  sourcePdfUrl: String
  rawFields: MoPublicationRaw # null unless requested; evidence-only (§2.5)
  firstSeenAt: DateTime!
  lastSeenAt: DateTime!
}

type MoLifecycleEdge {
  edgeId: BigInt!
  sourceMoActKey: ID!
  source: MoActPublication # DataLoader by mo_act_key
  relation: MoRelation!
  targetRaw: String!
  targetIndex: Int!
  # target citation-fragment identity — the ONLY way to describe a mo-only /
  # unresolved target (both targetActId and targetMoActKey null). Required for
  # introspectable mo-only edges (reviewer B3):
  targetActType: String
  targetActNumber: String
  targetActYear: Int
  targetIssuerSlug: String! # NOT NULL DEFAULT '' (migration line 164)
  targetActId: BigInt
  targetAct: LegalAct # portal type; DataLoader by act_id
  targetMoActKey: ID
  resolution: MoEdgeResolution!
  matchedVia: MoMatchedVia # enum, value-translated (§6.1)
  method: String!
  confidence: Float
}

type MoStatusEvent {
  eventId: BigInt!
  actId: BigInt!
  eventKind: MoStatusKind!
  effectiveDate: Date
  sourceActId: BigInt
  sourceAct: LegalAct # DataLoader by act_id
  eventSource: String! # always 'monitorul-oficial'
}

type MoIssuerYearCount {
  issuerSlug: String
  actType: String
  year: Int
  count: Int!
}
type MoCoverage {
  years: MoYearRange!
  gaps: [String!]!
  resolutionRates: MoResolutionRates
} # nullable: omitted on mo_issues (§5)
# connections (Relay; same cursor encoder as REST, §14.3)
type MoIssueConnection {
  edges: [MoIssueEdge!]!
  pageInfo: PageInfo!
  totalCount: Int
}
type MoActPublicationConnection {
  edges: [MoActPublicationEdge!]!
  pageInfo: PageInfo!
}
type MoLifecycleEdgeConnection {
  edges: [MoLifecycleEdgeEdge!]!
  pageInfo: PageInfo!
}

# ── root Query extensions ─────────────────────────────────────────────────────
extend type Query {
  moIssue(moIssueId: BigInt!): MoIssue
  moIssues(
    filter: MoIssueFilter
    first: Int = 20
    page: Int
    sort: MoIssueSort = ISSUE_DATE_DESC
  ): MoIssueConnection!
  moPublication(moActKey: ID!): MoActPublication
  moPublications(
    filter: MoPublicationFilter!
    first: Int = 20
    after: String
    sort: MoPublicationSort = ACT_YEAR_DESC
  ): MoActPublicationConnection!
  moEdges(filter: MoEdgeFilter!, first: Int = 20, after: String): MoLifecycleEdgeConnection!
  moPublicationsByIssuerYear(filter: MoPublicationAggFilter!): [MoIssuerYearCount!]!
}

# ── Entity join + LegalAct extension (foundation §6.2/§9; via contributor §14.7) ─
extend type Entity {
  monitorul: MoEntitySummary # issuer-keyed; resolved via contributor.profileSlice(cui)
}
extend type LegalAct { # MO consumer side of the correlation
  gazettePublications: [MoActPublication!]! # DataLoader by act_id → getPublicationsForAct
  gazetteStatusEvents: [MoStatusEvent!]! # DataLoader by act_id (event_source='monitorul-oficial')
  gazetteInEdges: [MoLifecycleEdge!]! # DataLoader by target_act_id
}
type MoEntitySummary {
  issuerSlug: String
  publicationCount: Int!
  byPartCode: [MoPartCount!]!
  lastIssueDate: Date
  topActTypes: [String!]!
  matchConfidence: Float!
}
```

**DataLoaders (prevent N+1 on `Entity`/`LegalAct` fan-out):** by `mo_issue_id`
(issue hydrate), by `mo_act_key` (edge.source), by `act_id` (publications,
status-events, in-edges, and the `act`/`targetAct`/`sourceAct` resolution which
calls **portal's** act loader, not MO's). The `Entity.monitorul` resolver MUST
call `contributor.profileSlice(cui)` (§14.7) — the same usecase REST entity-360
uses — never a separate query path.

**Conflict gate (§14.8):** all MO type/enum names are `Mo*`; the only shared
non-MO type referenced is portal's `LegalAct` (referenced + extended, never
redeclared). The CI schema-merge test must pass with portal's slice.

### §6.1 Enum value-translation layer (reviewer B4 — required for tri-surface equivalence)

GraphQL enum values **cannot contain hyphens**, but several DB CHECK values do.
Each affected enum has a **single canonical mapping table** consumed by both the
GraphQL serializer/parser AND the filter spec's `enumValues` + `canonicalizeFilters`
(§14.2), so the cursor `fhash` (§14.3) and the tri-surface equivalence test all
agree on the **DB value**, not the GraphQL alias:

| GraphQL alias               | DB value (driving column) | Used by                         |
| --------------------------- | ------------------------- | ------------------------------- |
| `MoEdgeResolution.mo_only`  | `'mo-only'`               | `mo_lifecycle_edges.resolution` |
| `MoStatusKind.aprobare_oug` | `'aprobare-oug'`          | `act_status_events.event_kind`  |
| `MoStatusKind.aprobare_og`  | `'aprobare-og'`           | `act_status_events.event_kind`  |
| `MoMatchedVia.act_year`     | `'act-year'`              | `*.matched_via`                 |
| `MoMatchedVia.issue_year`   | `'issue-year'`            | `*.matched_via`                 |

**Rule:** the GraphQL→DB direction runs at arg-parse time (before the spec
compiles to SQL); the DB→GraphQL direction runs in the mapper. Filter
`enumValues` in §7.1 carry the **DB values** (so SQL matches rows);
`canonicalizeFilters` lowercases the DB value, keeping REST (`resolution=mo-only`),
GraphQL (`mo_only`), and MCP (`mo-only`) producing one identical `fhash`. A unit
test asserts every enum value round-trips (§12). Non-hyphenated enums
(`MoResolution`, `MoRelation`, `MoPartCode`) need no translation.

---

## §7. Filters — the collection filter specs (priority area)

MO declares **specs** consuming the kernel filter pipeline (foundation §14.2);
it invents no DSL. Each field: operator → driving column/index → REST param ↔
GraphQL input ↔ MCP input. MO reuses portal's `act_type`/`issuer`/`year` family
specs (A4) and adds MO-only fields. **No `GeographicFilter`** (gazette is
national) — declared absent.

### 7.1 Filter specs (`CollectionFilterSpec`)

**`mo_issues`** (collection `mo_issues`, sort default `ISSUE_DATE_DESC`):

| field               | type   | ops                 | driving column / index                       | REST                | GraphQL        | MCP            |
| ------------------- | ------ | ------------------- | -------------------------------------------- | ------------------- | -------------- | -------------- |
| `year`              | int    | `eq` (**required**) | `mo_issues.issue_year` (bounds the scan)     | `year=`             | `year`         | `year`         |
| `partCode`          | enum[] | `in`                | `mo_issues.part_code` (CHECK enum)           | `partCode=PI,PII`   | `[MoPartCode]` | `part_code[]`  |
| `dateFrom`/`dateTo` | date   | `between`           | `mo_issues.issue_date`                       | `dateFrom`/`dateTo` | `{from,to}`    | `date_from/to` |
| `hasPdf`            | bool   | `eq`                | `mo_issues.has_emonitor_link`                | `hasPdf=true`       | `hasPdf`       | `has_pdf`      |
| `q`                 | string | `contains`          | `mo_issues.issue_label` (ILIKE; small table) | `q=`                | `q`            | `q`            |

**`mo_act_publications`** (collection `mo_publications`, sort default `ACT_YEAR_DESC`;
**≥1 bounding predicate required**: `actYear` ∨ `issuerSlug` ∨ `actId` ∨ `moIssueId`):

| field        | type     | ops            | driving column / index                                 | REST                       | GraphQL          | MCP             |
| ------------ | -------- | -------------- | ------------------------------------------------------ | -------------------------- | ---------------- | --------------- |
| `actType`    | enum[]   | `in`, `isNull` | `act_type` (rederived)                                 | `actType=lege,oug`         | `[String]`       | `act_type[]`    |
| `issuerSlug` | string[] | `in`, `isNull` | `issuer_slug` (cache-backed resolve)                   | `issuerSlug=`              | `[String]`       | `issuer_slug[]` |
| `actYear`    | int      | `eq`,`between` | `act_year`                                             | `actYear`/`actYearFrom/To` | `{from,to}`      | `act_year`      |
| `issueYear`  | int      | `eq`           | `issue_year`                                           | `issueYear`                | `issueYear`      | `issue_year`    |
| `resolution` | enum[]   | `in`           | `resolution` (CHECK enum)                              | `resolution=unique`        | `[MoResolution]` | `resolution[]`  |
| `actId`      | bigint   | `eq`, `isNull` | `act_id` (partial idx)                                 | `actId=`                   | `actId`          | `act_id`        |
| `moIssueId`  | bigint   | `eq`           | `mo_issue_id` (idx)                                    | `moIssueId=`               | `moIssueId`      | `mo_issue_id`   |
| `q`          | string   | `contains`     | `title` (Meili/OS-backed when up; ILIKE fallback — §9) | `q=`                       | `q`              | `q`             |

**`mo_lifecycle_edges`** (collection `mo_edges`, sort `EDGE_ID`; the only indexed
predicates are `sourceMoActKey` (uq prefix) and `targetActId` (partial idx) —
`relation`/`resolution` are unindexed CHECK enums. v1 accepts unfiltered/`relation`-
only lists as a **bounded full scan** of the 20,897-row table, cheap like
`listIssues`; reviewer S2):

| field            | type   | ops  | driving column / index             | REST                | GraphQL              | MCP                 |
| ---------------- | ------ | ---- | ---------------------------------- | ------------------- | -------------------- | ------------------- |
| `relation`       | enum[] | `in` | `relation` (CHECK enum)            | `relation=promulga` | `[MoRelation]`       | `relation[]`        |
| `resolution`     | enum[] | `in` | `resolution` (CHECK enum)          | `resolution=`       | `[MoEdgeResolution]` | `resolution[]`      |
| `sourceMoActKey` | string | `eq` | `source_mo_act_key` (FK/uq prefix) | `sourceMoActKey=`   | `sourceMoActKey`     | `source_mo_act_key` |
| `targetActId`    | bigint | `eq` | `target_act_id` (partial idx)      | `targetActId=`      | `targetActId`        | `target_act_id`     |

`isNull` is mandatory on `actType`/`issuerSlug`/`actId` (catalog coverage
questions — "publications with no resolved act"). Negation only on `exclude:true`
fields (`actType`, `issuerSlug`, `resolution` carry `exclude:true`). `canonicalizeFilters`
output feeds the cache key + cursor `fhash` + tri-surface equivalence test (§14.2/§14.3).

### 7.2 Text engine for `q`

- `mo_publications.q` and `mo_issues.q`: **OpenSearch** (full-text on `mo_act`
  docs in `search.documents`) when `opensearch=true`; degrade to Postgres `ILIKE`
  on `title`/`issue_label` (capability-gated, §14.5). **Meili** backs the discovery
  `/filters/resolve?dim=mo_issuer` prefix autocomplete. Semantic is **off** for MO
  v1 (no MO vector column in serving; §9) — semantic params return `null` +
  `caveats:["semantic search unavailable"]`, never error.

### 7.3 Discovery / name-resolution dimensions (§7.4, shared kernel)

MO exposes for `/legal/filters/resolve` and the MCP discovery tool:

- `mo_issuer` — Romanian issuer name → `issuer_slug` (via the cached slug→label+count
  map; 367 distinct slugs). Echoes the resolved slug + publication count.
- `mo_part` — part label ("Partea I") → `part_code`.
- `mo_act_type` — act-type label → normalized `act_type` value.

Act-name/CUI resolution is **delegated to the kernel/portal** (MO has no CUI and
no act identity of its own); MO resolves only gazette-native dimensions.

### 7.4 Golden question→filter examples (from `AI_AGENT_FILTER_QUESTION_CATALOG.md`)

| Catalog ID | Question                                           | Resolved MO filter / call                                                                                                                                                                 |
| ---------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MO-1**   | What did issuer X publish in year Y by subtype?    | `resolveIssuer('Ministerul Finanțelor')→slug`; `moPublicationsByIssuerYear{issuerSlug, year, groupBy:'act_type'}` → count + denominator + coverage                                        |
| **MO-4**   | Where/when was act X published in MO?              | portal resolves act name→`act_id`; `GET /legal/acts/:actId/publications` → `MoActPublication[]` (issue, part, date, page)                                                                 |
| **MO-3**   | MO sections that cite/amend act X                  | `GET /legal/acts/:actId/gazette-timeline` → `inEdges` (MO `mo_lifecycle_edges` targeting `act_id`) + confidence (full-text MO-3 is search-backed, §9, capability-gated)                   |
| **LG-2**   | What amended/approved/repealed act X (MO evidence) | `actLifecycle(actId)` → `statusEvents` (promulgare/aprobare) + `inEdges` (respinge/rectifica)                                                                                             |
| **LG-3**   | Status of act X + evidence                         | MO **slice** of LG-3: `getStatusEventsForAct(actId)` (the answer's authority is portal's `acts.status` fold; MO contributes the gazette-grounded evidence events, labeled distinct grain) |
| **XS-2**   | Bill → law → MO publication → amendments           | parliament/portal resolve act_id; MO supplies `wherePublished(actId)` + `gazetteInEdges` (the gazette legs of the cross-source timeline)                                                  |

**Grain note (foundation §14.6):** MO answers carry **counts of publication
events** (deterministic SQL over `mo_*`). MO never computes money totals (no
flows). Where an answer combines MO counts with portal's act status fold (LG-3),
both grains are labeled, and the **status authority is portal**, MO the evidence.

---

## §8. MCP tools

Two families (foundation §6.3): one **discovery** + query tools. TypeBox in/out;
handler calls a core usecase; output `{ ok, kind, query, link, item|items,
summary? }`. `link` is the client deep link. Rate-limited; bounded result sizes.

### 8.1 Discovery — `resolve_mo_filter`

- **Input:** `{ dim: 'mo_issuer'|'mo_part'|'mo_act_type', q: string, limit?: number(≤20) }`
- **Output:** `{ ok, kind:'resolution', query, items:[{value,label,count}], summary }`
- **Usecase:** `resolveIssuer` / static maps. Wraps `/legal/filters/resolve`.
- **Summary tmpl:** `"'{q}' → {n} matches; top: {label} ({count} publications)"`.

### 8.2 `find_act_publications` (MO-4)

- **Input:** `{ actId: BigInt }` (resolve act name→id via portal's discovery first)
- **Output:** `{ ok, kind:'mo_publications', items:[MoActPublication], coverage, link, summary }`
- **Usecase:** `wherePublished`. **Link:** `/legal/acts/{actId}#gazette`.
- **Summary:** `"Act {actId} published {n}× in MO; first {minDate} (Partea {part}, nr {label})."`

### 8.3 `get_act_gazette_timeline` (LG-2 / MO-3 MO slice)

- **Input:** `{ actId: BigInt }`
- **Output:** `{ ok, kind:'mo_timeline', item:{ statusEvents, inEdges }, coverage, link, summary }`
- **Usecase:** `actLifecycle`. **Link:** `/legal/acts/{actId}#timeline`.
- **Summary:** `"Act {actId}: {nPromulg} promulgation + {nApprove} approval status events; {nReject} rejection + {nRect} rectification edges grounded in MO."`
  — **`nPromulg`/`nApprove` count `statusEvents`; `nReject`/`nRect`/republicare count `inEdges`** (relation `respinge`/`rectifica`/`republica`). `respinge` is edge-only — it never appears in `MoStatusEvent` (reviewer B1; migration line 53).

### 8.4 `browse_mo_issues`

- **Input:** `{ year: int (req), partCode?: [string], dateFrom?, dateTo?, page?, pageSize?(≤50) }`
- **Output:** `{ ok, kind:'mo_issues', items:[MoIssue], meta, coverage, link, summary }`
- **Usecase:** `browseIssues`. **Link:** `/legal/mo-issues?year={year}&part={...}`.

### 8.5 `count_mo_publications_by_issuer` (MO-1)

- **Input:** `{ issuerSlug?: string, year: int (req), actType?: [string], groupBy?: 'issuer'|'act_type'|'year' }`
- **Output:** `{ ok, kind:'mo_aggregate', items:[MoIssuerYearCount], denominator, coverage, link, summary }`
- **Usecase:** `issuerYearBreakdown`. Deterministic count (catalog Aggregate Accuracy Gate). **Summary:** `"{issuer} published {total} acts in {year}: {topType} ({n})…"`.

All tools that produce counts attach `denominator` + `coverage` + `confidence:'deterministic'`
per the catalog Core Rule; on a coverage gap (e.g. 2012–2019 archive hole touched)
they return the partial result with explicit `caveats`, never a silent number.

---

## §9. Search integration

> **⚠ Contract reconciliation (flag for orchestrator).** Foundation §4.5/§9 name
> MO's doc_type as `mo_publication`. The **live scrapper migrations** (source of
> truth, F4) use **`mo_act`** (deterministic metadata-backbone projection),
> **`mo_section`** (MO-B extracted sections), and **`mo_section_metadata`**
> (generated LLM section metadata) — see
> `20260613T023000__search_documents_mo_section_doc_type.ts` and
> `20260615T150000__monitorul_generated_search_doc_type.ts`. **This plan uses the
> live names.** Recommendation: update foundation §4.5/§9 `mo_publication` →
> `mo_act` (+ note `mo_section`/`mo_section_metadata`).

- **doc_type(s) MO owns:** `mo_act` (live, ships with MO-A backbone — the v1
  serving doc_type), and the **deferred** `mo_section` / `mo_section_metadata`
  (MO-B/MO-C full-text + generated metadata; the doc-type CHECK is already
  widened in prod but rows are loaded by the scrapper `search` lane, not the
  server).
- **Projection into `search.documents` (written by the scrapper `search` lane;
  server reads only):** `mo_act` row = `{ doc_id: 'mo_act:'||mo_act_key,
doc_type:'mo_act', title: COALESCE(title,'(fără titlu)'), body: derived
citation+issuer string, cuis: '{}'::text[] (MO has no CUI), doc_date: act_date,
amount_ron: null, county_name: null, url: source_pdf_url, attrs:
{issuer_slug, act_type, issue_year, part_code, resolution, act_id} }`. The
  server's MO `q` filter queries this via the kernel SearchRepo.
- **Index names:** Meili `mo_acts` (instant title/issuer autocomplete for
  discovery), OpenSearch `mo_acts` (full-text relevance for `q` only). MO-C adds
  OpenSearch `mo_sections` (full-text extracted body) — capability-gated, not v1.
- **⚠ Aggregates are Postgres-only (reviewer S3, §14.6 grain gate + catalog
  Aggregate Accuracy Gate).** `count_mo_publications_by_issuer` / `issuerYearBreakdown`
  count over `legal.mo_act_publications` **deterministically** — OpenSearch terms
  aggregations are NOT used as a count fallback (the `mo_act` projection covers
  only resolved/projected rows, not the full 148,856; index lag breaks determinism).
  Search backs only `q` relevance/discovery, never a gated count.
- **Semantic gating (§14.5):** MO has **no vector column** in serving
  (`search.documents` has none; `legal.document_embeddings`/`section_embeddings`
  are **portal's** act/section vectors, not MO's). MO semantic fields/endpoints
  return `null` + `caveats:["semantic search unavailable"]` when `semantic=false`.
  MO-C may project `mo_section_metadata.semantic_text` into a future vector
  column — out of scope here; the catalog flags "after checking for prompt/
  plumbing leakage".

---

## §10. Sync / freshness impact on serving

MO is **append-mostly** (`MONITORUL_NOTES.md` gate item 10): publications never
mutate; rectifications/republications are **new rows + new edges**, never updates.
Daily tail = archive page-1 + e-monitor calendar + PDF download + (MO-B) extract +
loader run. **Re-extraction only on `extractor_version` bump.** Loader writes are
idempotent (ON CONFLICT on the case-folded issue identity / `mo_act_key` PK /
edge natural key) with zero-drift convergence (NOTES A8).

Serving impact:

- **Cache TTLs** (§5) are loader-cadence-driven, not request-driven. Per §14.11,
  read a per-domain loader-completion version stamp (`etl`/`system_control`) if
  one exists for `legal`; **interim is TTL-only** — stated explicitly (no
  `legal` loader-version signal confirmed in this plan's recon). MO responses
  surface an **"as-of"** watermark, computed cheaply (reviewer S6 — `last_seen_at`
  is **unindexed** on the 148K-row publications table, so a blanket
  `max(last_seen_at)` is a full scan and is **not** done per request): the
  watermark is the `max(last_seen_at)` of the **already-materialized result set**
  (free — rows are in hand), and a process-level cached global watermark
  refreshed on the cache TTL (one bounded scan per TTL window, not per request).
  Never a per-request unbounded `max()`.
- **No "phase/status mutation" problem** (unlike procurement) — MO rows don't
  move through phases. The only mutability is `act_id` **churn** (portal orphan
  cleanup nulls `act_id` via `ON DELETE SET NULL`; MO re-resolves every run).
  Serving must treat `act_id=null` on a `resolution='unique'` row as the
  documented transient churn marker, not an error (NOTES backbone DDL note).
- **Coverage drift:** when the 2011–2020 backfill lands, the per-year coverage
  block changes; the `coverage` payload is computed live (cheap counts), so it
  self-updates — no API change needed.

---

## §11. Wiring

- **`makeMonitorulSurface(deps)`** (composed by portal's `makeLegalModule`, A1):
  `deps = { db: Kysely<ProdDatabase>, search: SearchRepo, identity: IdentityRepo,
cache, legalActMapper (from portal A3) }`. Returns `{ restRoutes, typeDefs,
resolvers, mcpTools, entityExtension, contributor }`.
- **Repos:** `MonitorulRepo` (Kysely over `legal.mo_*` + `legal.act_status_events`
  - read `legal.acts`). No new clients (reuses kernel Meili/OS via SearchRepo).
- **Env additions:** **none** — MO reuses kernel env (`PROD_DATABASE_URL`,
  `MEILI_*`, `OPENSEARCH_URL`). New Meili/OS index names (`mo_acts`) are constants,
  not env. Module feature-flag key (if the kernel uses a module enable-list):
  `legal` (single module; MO is not independently flaggable — it ships inside
  `legal`).
- **build-app registration:** portal's `makeLegalModule` is built once; it
  internally composes MO. The kernel then registers the single `legal` REST
  plugin, merges the (portal+MO) GraphQL slice, registers (portal+MO) MCP tools,
  and registers exactly **one** contributor — `monitorul-oficial` (issuer-keyed,
  best-effort, low-confidence). Portal registers **no** contributor in v1 (RECONCILED,
  foundation §9). Order is data-independent.
- **Legacy superseded:** the monolithic `unified` module's MO surface (the old
  `legal.mo_acts` sandbox table name — NOTES warns E2E probes must use the split
  backbone `mo_issues`/`mo_act_publications`/`mo_lifecycle_edges`, **not**
  `mo_acts`). No standalone legacy MO GraphQL module exists to retire.

---

## §12. Testing

- **Unit** (`tests/unit/legal/monitorul/`): `MonitorulRepo` SQL via filter-spec →
  WHERE compilation snapshot tests (each §7.1 field → expected parameterized SQL);
  cursor encode/decode for `(act_year, mo_act_key)` incl. `fhash` mismatch →
  `InvalidInput`; **enum value round-trip** (§6.1 — `mo_only`↔`mo-only`,
  `aprobare_oug`↔`aprobare-oug`, `act_year`↔`act-year` in both filter compile +
  mapper, asserting one identical `fhash` across REST/GraphQL/MCP); mappers
  (row → `MoIssue`/`MoActPublication`/`MoLifecycleEdge`/`MoStatusEvent`,
  incl. the mo-only edge with null `targetActId`+`targetMoActKey` exposing
  `targetActType/Number/Year/IssuerSlug`); the §2.1 `mo_part/mo_number/mo_date` →
  issue conversion rule
  (case-fold + whitespace-strip); `act_id=null` churn handling.
- **Integration** (`tests/integration/legal/monitorul/`): REST + GraphQL + MCP
  against a seeded fixture schema; **tri-surface equivalence** — `find_act_publications`
  (MCP) ≡ `GET /legal/acts/:id/publications` (REST) ≡ `LegalAct.gazettePublications`
  (GraphQL) for the same `act_id` (the §14.7 contributor parity test); coverage
  block present on every list/aggregate; `?include=raw`/`?expand=act` opt-ins;
  semantic-gating returns `null`+caveat (not error) when `semantic=false`;
  schema-merge conflict gate passes alongside portal's slice (§14.8).
- **Golden filters** (from §7.4): MO-1, MO-4, MO-3, LG-2, LG-3-MO-slice, XS-2-MO-legs
  as integration cases with expected SQL recomputation on a frozen snapshot
  (catalog Aggregate Accuracy Gate); refusal/partial-coverage case (query touching
  the 2012–2019 archive hole returns partial + caveat).

---

## §13. Open questions / risks

- **R1 — doc_type name mismatch (decision needed).** Foundation §4.5/§9 say
  `mo_publication`; live prod uses `mo_act` (+ `mo_section`, `mo_section_metadata`).
  This plan follows live (F4). **Orchestrator: reconcile foundation §4.5/§9 to the
  live names.** (Low risk; cosmetic, but the contract should match prod.)
- **R2 — portal skeleton dependency (reconciliation).** §0 lists every assumption
  about 05. If 05 makes `legal` a two-factory module or names `LegalAct`/the act
  mapper differently, only the named symbols change. **Highest-leverage item for
  the consistency pass.**
- **R3 — earned indexes (measured-workload follow-up, not blocking).** `listIssues`
  has no `(issue_year, issue_date, part_code)` index and `listPublications` no
  `(act_year, act_type, issuer_slug)` composite. v1 enforces a **mandatory
  bounding predicate** (`year`/`act_year`/issuer/issue), and 42K/148K rows make
  the bounded scans cheap; if EXPLAIN on the live workload shows these hot, the
  scrapper adds the index (server is read-only — index creation is a scrapper
  migration, foundation §3). Stated so the orchestrator/loader owner can pre-empt.
- **R4 — issuer→CUI link is best-effort.** MO has no CUI; `Entity.monitorul` and
  `presenceFor` resolve issuer_slug→org by name (kernel identity hub). This is
  **labeled low-confidence**, never a hard link, and excluded from any
  spend/ranking answer (MO has none anyway). Risk: false-positive issuer↔org
  matches in entity-360 — mitigated by `matchConfidence` on `MoEntitySummary`.
- **R5 — MO-only acts not in `legal.acts` (v1 posture).** `resolution='unmatched'`
  publications (the ~84K long tail) carry `act_id=null`; they are queryable by
  MO-local identity (`mo_act_key`, issuer/type/number/year filters) but have **no
  `LegalAct`**. Gate item 1 (issuer overlap 97.99% row-weighted) makes future
  `legal.acts` promotion viable; that is a **scrapper/loader decision** (MO-C),
  not a server one. The server surface already handles `act_id=null` gracefully.
- **R6 — full-text MO-3 (cite/amend) is search-backed + deferred.** The
  deterministic `mo_lifecycle_edges` answer ships v1 (`gazetteInEdges`); the
  full-text "MO sections that cite act X" (catalog MO-3 over extracted sections)
  needs MO-B `mo_section` docs in OpenSearch — capability-gated, MO-C, surfaced
  with `caveats` until live.
