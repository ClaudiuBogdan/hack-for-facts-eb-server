# 05 — portal-legislativ (the `legal` acts surface + RAG/semantic layer)

> **Status:** plan. Conforms to `00-foundation-shared-kernel.md` (binding).
> **Schema:** `legal.*` (acts/sections part; MO part owned by `06-monitorul-oficial.md`).
> **Co-ownership:** portal-legislativ (this plan) OWNS the `legal` module skeleton
> (module index, shared legal repo base, the `LegalAct` GraphQL base type, the
> shared legal filter families `act_type`/`issuer`/`domain`/`year`). `06` EXTENDS
> it — it must not redefine the module index or `LegalAct`. The act↔MO correlation
> contract that `06` consumes is in §6 (GraphQL) and §13.
> **Legacy superseded:** none directly (legal was never in the old `unified`
> module); the closest prior art is `src/modules/unified/` (repo/route hexagon).

---

## 1. Summary & data status

The legal corpus is **fully loaded and queryable** in `transparenta_prod.legal`
(P0 + P1 of the slice are done; the AI metadata, citation graph, status
derivation, sections, and embeddings all landed). Live counts (introspected
2026-06-16, griffin `transparenta-prod-postgres-1`):

| Table | Rows | Notes |
|---|---:|---|
| `legal.acts` | 223,611 | logical acts; `act_natural_key` unique; `status` scalar + `status_evidence` jsonb |
| `legal.act_documents` | 225,401 | document expressions; **223,611 canonical**; `mo_part` populated on only **3** (see §13 gotcha) |
| `legal.act_citation_keys` | 196,520 | child identity table (one act → many keys for joint-ministry orders) |
| `legal.act_aliases` | 90 | `codul fiscal`, `codul muncii`, … |
| `legal.act_references` | 1,103,595 | resolved edges; **627,759 (56.9%) carry `target_act_id`** (~80.5% of domestic-numbered) |
| `legal.act_status_events` | 81,214 | event substrate; `event_source` ∈ {portal, monitorul-oficial} |
| `legal.external_acts` | 20,779 | EU/pre-1989/treaties graph closure |
| `legal.document_nodes` | 1,220,387 | intra-act tree (articol/alineat/…); 12.7% of standard-article docs have node gaps (parser-v1 blind spot) |
| `legal.document_summaries` | 224,950 | AI metadata projection (domains, keywords, fiscal flags) |
| `legal.document_embeddings` | 224,950 | doc-level `general-v1`, `vector(768)`, partial HNSW |
| `legal.section_embeddings` | 2,938,113 | section-level `article-v1`, `vector(768)`, partial HNSW — **full corpus** (user decision #3) |

Status distribution (NOTES evidence): in-vigoare 193,981 · abrogat 22,125 ·
modificat 6,542 · abrogat-partial 762 · iesit-din-vigoare 124 · suspendat 55 ·
necunoscut 22.

Search projection already populated: `search.documents` carries **`legal_act`
223,611** + **`portal_section` 2,938,113** rows (the discriminators portal owns —
§9). MO owns `mo_act` / `mo_section` / `mo_section_metadata`.

**Deferred (out of this module's serving scope):** consolidation fetch (P2 — the
corpus serves *originals* under the §5.2-C default policy, with mandatory status
badge + "modificat de N acte" warning); resolver v2 (multi-number ordins,
fragment locators); raw-HTML link mining. The server reads what P0/P1 produced;
it never writes or re-resolves.

**Capability gating:** semantic/vector search over `document_embeddings` /
`section_embeddings` **is live in `transparenta_prod`** (HNSW present). This is a
deviation from foundation §4.5/§14.5, which assumed no vector column yet. The
module therefore exposes semantic retrieval **but still through the kernel's
`SearchCapabilities.semantic` gate** (§14.5): if `semantic=false` (vector ext or
HNSW unavailable at boot, or pgvector deliberately disabled in an env), semantic
fields degrade to `null` + `caveats:["semantic search unavailable"]` and the
lexical/trigram path serves. **Rationale:** the foundation gate is the cross-source
contract; portal opts *in* to semantic where present rather than hard-depending.

---

## 2. Schema → domain model

Module path: `src/modules/legal/` (ONE module, two authoring areas — §11). View
models live in `legal/core/types.ts` (05-owned, shared with the `mo/` area). All
scalars per foundation §14.1 (`org_id`→string `BigInt`; `act_id`→string `BigInt`;
money→string; dates→`YYYY-MM-DD`). **Type note for 06:** `act_documents.document_id`
is `text`, NOT `bigint` — `LegalDocument.documentId`, `LegalReferenceEdge.sourceDocumentId`,
and all `*_embeddings.document_id` keys are `String`, never `BigInt`. Only
`act_id`, `node_id`, `external_act_id`, `event_id`, `mo_issue_id` are bigint.

### 2.1 Core view models (portal-owned)

```ts
// legal/core/types.ts  — domain-prefixed, structurally PII-free (no PII columns in legal)

export type LegalActStatus =
  | 'in-vigoare' | 'modificat' | 'abrogat' | 'abrogat-partial'
  | 'suspendat' | 'iesit-din-vigoare' | 'necunoscut';

export interface LegalAct {                       // legal.acts
  readonly actId: string;                         // bigint → string
  readonly actNaturalKey: string;
  readonly actType: string;                       // lege|oug|og|hotarare|ordin|decizie|decret|...
  readonly actNumber: string | null;
  readonly actYear: number | null;
  readonly issuerSlug: string | null;
  readonly canonicalDocumentId: string | null;
  readonly displayCitation: string;               // "Legea nr. 227/2015"
  readonly status: LegalActStatus;
  readonly statusEvidence: Record<string, unknown>;   // jsonb: which signals fired
  readonly entryIntoForce: string | null;         // date
  readonly inDegree: number;                       // incoming citation count
}

export interface LegalActCard extends LegalAct {  // act detail: act + canonical doc + summary
  readonly canonical: LegalDocument | null;
  readonly summary: LegalActSummary | null;
  readonly aliases: readonly string[];
  readonly citationKeys: readonly LegalCitationKey[];
  readonly versionCount: number;                   // act_documents rows for this act
  readonly amendedAfterPublication: number;        // count of incoming modifica/completeaza edges → the §5.2-C warning
}

export interface LegalDocument {                  // legal.act_documents
  readonly documentId: string;
  readonly actId: string;
  readonly versionKind: 'original'|'republicare'|'corp'|'stub-header'|'consolidare';
  readonly versionDate: string | null;
  readonly isCanonical: boolean;
  readonly den: string | null;
  readonly title: string | null;
  readonly issuerRaw: string | null;
  readonly publicationRaw: string | null;
  readonly entryIntoForce: string | null;
  readonly firstPublicationDate: string | null;
  readonly statusMarkers: readonly string[];
  readonly extractionStatus: string | null;
  readonly compatibilityTier: string | null;
  // act↔MO typed link (correlation contract for 06 — §13):
  readonly moPart: number | null;
  readonly moNumber: string | null;
  readonly moDate: string | null;
}

export interface LegalActSummary {                // legal.document_summaries (AI projection)
  readonly documentId: string;
  readonly description: string | null;
  readonly summary: string | null;
  readonly plainLanguageSummary: string | null;
  readonly documentCategory: string | null;       // lege|ordin|hotarare-de-guvern|...
  readonly domains: readonly string[];             // controlled 16-value vocab
  readonly affectedAudiences: readonly string[];
  readonly keywords: readonly string[];
  readonly keyDates: unknown | null;               // jsonb
  readonly penaltiesMentioned: boolean | null;
  readonly fiscalImpact: string | null;
  readonly confidence: number | null;              // soft filter only
  readonly sourceExtractionStatus: string | null;  // 'accepted' | 'suspicious' (RAG-exclude suspicious)
}

export interface LegalCitationKey {               // legal.act_citation_keys
  readonly actType: string; readonly actNumber: string;
  readonly actYear: number;  readonly issuerSlug: string;
}

export interface LegalReferenceEdge {             // legal.act_references
  readonly sourceDocumentId: string;
  readonly refIndex: number;
  readonly relation: 'modifica'|'abroga'|'completeaza'|'suspenda'|'aproba'|'rectifica'|'face-referire'|'respinge';
  readonly targetRaw: string;
  readonly targetClass: string;
  readonly targetActId: string | null;            // resolved domestic act
  readonly targetExternalActId: string | null;    // resolved external act
  readonly targetFragment: string | null;         // 'art. 2, anexa 2' when sub-act
  readonly resolution: 'unique'|'cluster'|'alias'|'ambiguous'|'unresolved'|'external';
  readonly confidence: number | null;
  readonly resolverVersion: string;
}

export interface LegalStatusEvent {               // legal.act_status_events
  readonly eventId: string;
  readonly actId: string;
  readonly eventKind: string;                      // abrogare-totala|modificare|promulgare|...
  readonly effectiveDate: string | null;
  readonly sourceActId: string | null;
  readonly evidence: Record<string, unknown>;
  readonly eventSource: 'portal'|'monitorul-oficial';   // 06 contributes MO events here
}

export interface LegalNode {                      // legal.document_nodes
  readonly nodeId: string;
  readonly documentId: string;
  readonly parentNodeId: string | null;
  readonly nodeKind: string;                       // articol|alineat|capitol|...
  readonly label: string | null;                   // 'Articolul 291'
  readonly numberKey: string | null;               // '291', '291^1', 'IV'
  readonly path: string;                           // materialized path
  readonly orderIndex: number;
  readonly charStart: number | null;               // offsets into clean_text (exact quote)
  readonly charEnd: number | null;
}

export interface LegalExternalAct {               // legal.external_acts
  readonly externalActId: string;
  readonly identityKey: string;                    // 'eu_directiva:2004/37/CE'
  readonly displayCitation: string;
  readonly kind: 'eu_directiva'|'eu_regulament'|'treaty'|'pre1989'|'other';
}

export interface LegalSectionHit {                // section retrieval result (parent-doc enriched)
  readonly actId: string;
  readonly displayCitation: string;
  readonly status: LegalActStatus;
  readonly documentId: string;
  readonly sectionKey: string;                     // 'art:291' | 'win:17'
  readonly articleNumber: string | null;
  readonly nodeLabel: string | null;               // 'Articolul 291'
  readonly nodePath: string | null;
  readonly charStart: number | null;               // forward-compat locator (NOT served text — §3.4)
  readonly charEnd: number | null;
  readonly snippet: string | null;                 // grounded snippet from document_summaries (in prod); node text is P2
  readonly portalDeepLink: string | null;          // deep link to the portal node, since text isn't in prod
  readonly score: number;                          // fused/cosine
}
```

### 2.2 Identity / territory linkage

- **CUI:** legal has **no CUI column** — acts are issued *by institutions*, not
  *to* CUIs. The link to the kernel identity hub is the **future `issuer_slug →
  institution`** axis (brief §"issuers→institutions" — deferred). The **acts/
  area contributes no `Entity` field and registers no contributor in v1** (§4) —
  there is no per-CUI legal-acts slice yet. (The `legal` module as a whole DOES
  register one contributor: the `mo/` area's **issuer-keyed** MO contributor —
  06/A5 — which is independent of the acts surface.) When the `issuer_slug →
  core.organizations` link lands, the acts area adds `extend type Entity {
  actsIssued: LegalActConnection! }` via a `profileSlice` that resolves an org's
  name → `issuer_slug` → acts issued. **No acts-side `Entity` field in v1.** This
  is the one place the acts surface does *not* yet participate in entity-360.
- **Territory (SIRUTA):** none. Legal acts are national; no geographic filter.
  The `GeographicFilter` family is **not** exposed by this module.

### 2.3 PII / excluded columns

Legal has **no PII** (acts are public law). No columns excluded for privacy.
Two *quality* exclusions from default projections:

- `document_summaries.sourceExtractionStatus = 'suspicious'` rows (3,649; stub/
  partial texts incl. the Legea 227/2015 header stub) are **excluded from RAG
  serving** (returned only with an explicit `includeSuspicious` flag) — they are
  metadata-grounded husks (NOTES §1.2).
- Non-canonical `act_documents` are **never served as the act's text** (default
  serving policy §5.2-C): retrieval and detail join `where is_canonical`.

---

## 3. Repo interface (ports)

`legal/core/ports.ts`. Every method returns `Result<T, ApiError>` (neverthrow).
All reads; no writes. Repos receive the kernel-typed Kysely instance and touch
only `legal.*` + (for search projection reads) `search.documents`.

### 3.1 `LegalRepoBase` — the **shared skeleton** repo (§9 skeleton, 06 reuses)

This is the extensible base both portal and MO build on. It owns act identity
resolution (the join target for MO's `act_id` FKs) and the shared status-event
read path.

```ts
export interface LegalActRef {                    // canonical way to address an act across surfaces
  readonly actId?: string;
  readonly citation?: string;                      // "legea 227/2015" | "codul fiscal" — resolved via keys/aliases
}

export interface LegalRepoBase {
  // identity resolution — the contract MO (06) and the discovery tool both call
  resolveActRef(ref: LegalActRef): Promise<Result<LegalAct | null, ApiError>>;       // acts.act_natural_key / citation_keys / aliases
  findActById(actId: string): Promise<Result<LegalAct | null, ApiError>>;
  findActsByIds(actIds: readonly string[]): Promise<Result<readonly LegalAct[], ApiError>>;  // DataLoader batch
  findActByCitationKey(k: LegalCitationKey): Promise<Result<readonly LegalAct[], ApiError>>; // → acts via act_citation_keys
  searchActsByName(q: string, limit: number): Promise<Result<readonly LegalAct[], ApiError>>; // pg_trgm on display_citation (fallback)
  // status events — shared read; portal & MO both write rows, server reads both via event_source
  getStatusEvents(actId: string, eventSource?: 'portal'|'monitorul-oficial'): Promise<Result<readonly LegalStatusEvent[], ApiError>>;
}
```

### 3.2 `LegalActsRepo` — portal-owned acts/detail/list

```ts
export interface LegalActListOptions {
  readonly filters: LegalActFilterInput;           // §7 compiled spec
  readonly sort: 'in_degree'|'act_year'|'entry_into_force'|'display_citation';
  readonly dir: 'asc'|'desc';
  readonly limit: number;                          // ≤ 100
  readonly cursor?: string | undefined;            // §14.3 envelope
}

export interface LegalActsRepo extends LegalRepoBase {
  listActs(o: LegalActListOptions): Promise<Result<{ rows: readonly LegalAct[]; nextCursor: string | null }, ApiError>>;
  getActCard(ref: LegalActRef): Promise<Result<LegalActCard | null, ApiError>>;     // act + canonical doc + summary + aliases + keys + amendedAfter
  getCanonicalDocument(actId: string): Promise<Result<LegalDocument | null, ApiError>>;
  listDocuments(actId: string): Promise<Result<readonly LegalDocument[], ApiError>>; // version cluster
  getSummary(documentId: string): Promise<Result<LegalActSummary | null, ApiError>>;
  countAmendmentsAfter(actId: string): Promise<Result<number, ApiError>>;           // incoming modifica/completeaza for the badge
}
```
Indexes hit: `acts_pkey`, `acts_act_natural_key_key`, `act_citation_keys_pkey`
(prefix for citation-key lookup), `act_documents_one_canonical` (canonical
join), `act_documents_act_id` (version cluster). List sort by `in_degree`
(R1's **default** sort) runs unindexed over 223k rows today — `legal.acts
(status, in_degree desc, act_id)` is a **recommended pre-launch scrapper
migration** (§13), not "earned if slow": the default sort guarantees the
workload on day one. The API cannot create it (foundation §3 read-only).

**Cursor tuple (BINDING):** every `sort` is non-unique (thousands of acts share
`in_degree=0`; `display_citation`/`act_year` tie heavily), so the cursor sort
tuple **always ends in `act_id`** (the PK) as the tiebreaker, and the seek
predicate is `(sortcol, act_id) <|> (?, ?)` per direction. Without the
`act_id` suffix, pagination skips/duplicates rows across pages.

### 3.3 `LegalGraphRepo` — citation/amendment graph (LG-1, LG-2)

```ts
export interface LegalGraphRepo {
  // outgoing: what this act cites (its source document's references)
  outgoingRefs(actId: string, relations?: readonly string[], limit?: number)
    : Promise<Result<readonly LegalReferenceEdge[], ApiError>>;          // via canonical document_id
  // incoming: what cites/amends/abrogates this act
  incomingRefs(actId: string, relations?: readonly string[], limit?: number)
    : Promise<Result<readonly { edge: LegalReferenceEdge; sourceAct: LegalAct | null }[], ApiError>>;  // act_references_target index
  externalAct(externalActId: string): Promise<Result<LegalExternalAct | null, ApiError>>;
}
```
Indexes hit: `act_references_target (target_act_id, relation)` (incoming —
the high-value "what amends L" path); `act_references_pkey` prefix on
`source_document_id` (outgoing). **Hub guard (research §4):** Legea 47/1992 has
23,527 in-edges; `incomingRefs` is always `limit`-bounded (≤200) and paginated —
never an unbounded hub fan-out.

### 3.4 `LegalTreeRepo` — intra-act structure (LG-4 context)

```ts
export interface LegalTreeRepo {
  nodeChildren(documentId: string, parentNodeId: string | null, depth: number)
    : Promise<Result<readonly LegalNode[], ApiError>>;                   // document_nodes_lookup / path prefix
  nodeByPath(documentId: string, path: string): Promise<Result<LegalNode | null, ApiError>>;
  nodeByArticle(documentId: string, numberKey: string): Promise<Result<LegalNode | null, ApiError>>;
}
```
**Node text gap (BINDING — §13 risk #3):** `document_nodes` carries char offsets
into raw `clean_text`, but the text itself lives in the raw cluster
(`portal_text`), which the server must not read (foundation §3). So **v1 nodes
return structure (label, kind, path, char range) only — no passage text.** The
grounded snippet for RAG/MCP answers comes from `document_summaries`
(`summary`/`semantic_text`/`plainLanguageSummary`), which IS in prod; char offsets
are a **forward-compatible locator** (deep-link into the portal / a future
`legal.node_texts` prod projection), not a served passage. This keeps the server
single-DB and avoids hollow "offsets pointing at unreadable text" citations.

### 3.5 `LegalRetrievalRepo` — full-text + semantic (LG-4, the RAG layer)

```ts
export interface LegalRetrievalQuery {
  readonly q: string;
  readonly filters: LegalActFilterInput;           // status/domain/category/type/year — pre-filter
  readonly channel: 'auto'|'sections'|'docs';      // §4 multi-vector routing
  readonly includeHistorical: boolean;             // §5.2-C: abrogated excluded unless true
  readonly limit: number;                          // ≤ 50
}

export interface LegalRetrievalRepo {
  // section channel (provision-level RAG): section_embeddings → parent doc/act/node
  searchSections(qVec: readonly number[] | null, q: LegalRetrievalQuery)
    : Promise<Result<readonly LegalSectionHit[], ApiError>>;            // HNSW when qVec; ILIKE/trigram fallback when null (semantic gate off)
  // doc channel (topical "about X"): document_embeddings
  searchDocs(qVec: readonly number[] | null, q: LegalRetrievalQuery)
    : Promise<Result<readonly { act: LegalAct; summary: LegalActSummary | null; score: number }[], ApiError>>;
}
```
**HNSW-parameter rule (research §5.1, BINDING):** the query vector MUST be passed
as a bound `$n::vector` parameter — a vector arriving via CTE/join silently
falls back to an 8s exact scan. The repo embeds `q` via the kernel
`synthetic-client` (`search_query:` prefix, nomic) **before** the SQL, then binds
the literal. `statement_timeout` 5s; HNSW `ef_search` is a DB GUC (already 150).

---

## 4. Usecases

`legal/core/usecases/` — framework-free, over ports, `Result`-returning. REST,
GraphQL, MCP all call these (tri-surface equivalence, §14.7).

| Usecase | Signature | Ports | Catalog |
|---|---|---|---|
| `listActs` | `(FilterInput, sort, page/cursor) → {rows, next}` | LegalActsRepo | LG-5 |
| `getAct` | `(LegalActRef) → LegalActCard` | LegalActsRepo (+Graph for badge) | LG-3 |
| `getActVersions` | `(actId) → LegalDocument[]` | LegalActsRepo | — |
| `getActLinks` | `(actId, direction, relations?, since?) → edges (+sourceAct)` | LegalGraphRepo | LG-1, LG-2 |
| `getActTimeline` | `(actId) → merged status events + keyDates + amendment edges` | Base + Graph | LG-2 |
| `getActTree` | `(actId|documentId, path?, depth) → LegalNode[]` | LegalTreeRepo | — |
| `searchLegal` | `(LegalRetrievalQuery) → {acts, sections, caveats}` | LegalRetrievalRepo (+kernel SearchClient/synthetic) | LG-4, LG-5 |
| `resolveLegalFilters` | `(dim, q) → resolved values` (discovery) | Base + kernel | LG-* |

**Cross-source contributor (§4.4 / §14.7):** **the acts/ surface registers NO
contributor in v1.** A contributor whose `presenceFor` always returns `null`
(legal acts have no per-CUI axis, §2.2) is dead weight in the kernel's entity-360
iteration and advertises a slice that never materializes. Cleaner per §4.4 to
simply *not* register an acts contributor until the `issuer_slug →
core.organizations` link lands; the acts surface then has no `Entity` field
(§6.2) — fully consistent (no field, no resolver, no divergence). When the
issuer→institution axis lands, the acts area registers:
```ts
// FUTURE (not v1): presenceFor resolves cui → institution name → issuer_slug → acts issued
const legalActsContributor: SourceContributor = { source: 'legal', presenceFor, profileSlice };
```
**Note for the consistency pass:** the `legal` *module* nonetheless registers
one contributor today — the `mo/` area's **issuer-keyed MO contributor** with
`source: 'monitorul-oficial'` (06/A5, real `presenceFor`/`profileSlice`),
composed in by `makeLegalModule` (§11). The acts area contributing none (future
`source: 'legal'`) and the MO area contributing one (`source:
'monitorul-oficial'`) use **distinct source keys**, so they never collide in the
registry — entity-360 gets an MO slice now and a legal-acts slice later, keyed
independently.
- **`doc_type`s registered** (§9): `legal_act` (act/doc topical) + `portal_section`
  (provision-level). **NOT** `mo_*` (06 owns those).
- **`flow_type`:** legal registers **none** (acts are not money flows).

---

## 5. REST endpoints

Prefix `/api/v1/legal/`. TypeBox on every query/param; `config:{public:true}`
(§14.11 auth). Envelope per §5.2/§14.11 (`ok/data/meta`+`requestId`). Cache
key `legal:<op>:<canonicalizeFilters>`; TTL-only until a loader version stamp
exists (§14.11) — stated explicitly: **interim TTL-only**.

| # | Method · Path | Query/params (TypeBox) | Response | Pagination | Cache TTL | stmt_timeout |
|---|---|---|---|---|---|---|
| R1 | `GET /legal/acts` | `LegalActFilter` (§7) + `sort`,`dir`,`cursor` | `LegalAct[]` | **cursor only** (large set; §14.4) | 300s | 5s |
| R2 | `GET /legal/acts/:idOrCitation` | path: act_id or url-encoded citation | `LegalActCard` | — | 600s | 5s |
| R3 | `GET /legal/acts/:id/documents` | — | `LegalDocument[]` (version cluster) | offset (small) | 600s | 5s |
| R4 | `GET /legal/acts/:id/links` | `direction=in\|out`, `relation[]`, `since?`, `page` | `{edge, sourceAct?}[]` | offset (bounded ≤200) | 300s | 5s |
| R5 | `GET /legal/acts/:id/timeline` | — | merged events+keyDates+edges | — | 600s | 5s |
| R6 | `GET /legal/acts/:id/tree` | `documentId?`, `path?`, `depth=1..3` | `LegalNode[]` | — | 600s | 5s |
| R7 | `GET /legal/search` | `q` (req), `LegalActFilter`, `channel`, `includeHistorical`, `limit≤50` | `{acts, sections, caveats}` | offset (top-K) | 120s | 30s (search class) |
| R8 | `GET /legal/filters/resolve` | `dim`, `q`, `limit` | `{values:[{value,label,count?}]}` | — | 300s | 5s |
| R9 | `GET /legal/external-acts/:id` | — | `LegalExternalAct` | — | 600s | 5s |

Notes:
- **R1 is cursor-only** (223k acts; foundation §14.4 — large set). No `page`/
  `OFFSET` path is offered (deep-offset over 223k is exactly what §14.4 prevents).
  If a `totalCount` is shown in the GraphQL connection it is `{total,
  estimated:true}` (planner estimate via `pg_class.reltuples` scoped by the
  filter where cheap), never a blocking `COUNT(*)`.
- **R2** accepts either a numeric `act_id` or a URL-encoded citation
  ("legea-227-2015" / "codul-fiscal") resolved via `resolveActRef` (citation
  keys/aliases). 404 `NotFound` when unresolved.
- **R7** is the hybrid retrieval endpoint. `caveats` carries the §5.2-C honesty
  payload (per act: status badge + `amendedAfterPublication`) and, when
  `SearchCapabilities.semantic=false`, `["semantic search unavailable"]` with the
  channel degraded to lexical. Its **30s budget** (vs the 15s aggregate class)
  explicitly accounts for the synthetic embedding round-trip (`q` embedded with
  `search_query:` before SQL) + 3-engine fan-out (Meili + OpenSearch BM25 +
  pgvector HNSW, cold ~1.5s) + RRF fusion — 15s is too tight cold. It is closer
  to the `ask` class than a simple read.
- **OpenAPI:** module exports a `legal` fragment; kernel merges into
  `/api/v1/openapi.json`. Every list declares default sort + allowed sort enum.
- Resource grammar additions (§14.11): no `/aggregate` endpoint in v1 (legal has
  no numeric rollups); `/filters/resolve` is R8.

---

## 6. GraphQL

In-process schema stitching (§6.2). Types **always** `Legal*`-prefixed
(§14.8); MO uses `Mo*`. **This module owns the `LegalAct` base type** (§9); 06
extends `legal` Query/Entity independently and must not redefine `LegalAct`.

### 6.1 SDL (portal-owned types)

```graphql
scalar BigInt   # kernel
scalar Date     # kernel
scalar JSON     # kernel

enum LegalActStatus { IN_VIGOARE MODIFICAT ABROGAT ABROGAT_PARTIAL SUSPENDAT IESIT_DIN_VIGOARE NECUNOSCUT }
enum LegalRelation  { MODIFICA ABROGA COMPLETEAZA SUSPENDA APROBA RECTIFICA FACE_REFERIRE RESPINGE }
enum LegalSortKey   { IN_DEGREE ACT_YEAR ENTRY_INTO_FORCE DISPLAY_CITATION }

type LegalAct {                       # the shared base type (§9)
  actId: BigInt!
  actType: String!
  actNumber: String
  actYear: Int
  issuerSlug: String
  displayCitation: String!
  status: LegalActStatus!
  statusEvidence: JSON!
  entryIntoForce: Date
  inDegree: Int!
  # lazy fields (DataLoader / repo, not on the row):
  canonical: LegalDocument
  summary: LegalActSummary
  aliases: [String!]!
  citationKeys: [LegalCitationKey!]!
  versionCount: Int!
  amendedAfterPublication: Int!        # the §5.2-C honesty count
  documents: [LegalDocument!]!
  links(direction: LegalLinkDirection!, relation: [LegalRelation!], since: Date, first: Int = 50): LegalReferenceConnection!
  timeline: [LegalStatusEvent!]!
  tree(documentId: BigInt, path: String, depth: Int = 1): [LegalNode!]!
}

enum LegalLinkDirection { IN OUT }

type LegalDocument {
  documentId: String!
  versionKind: String!
  versionDate: Date
  isCanonical: Boolean!
  den: String
  title: String
  issuerRaw: String
  publicationRaw: String
  entryIntoForce: Date
  firstPublicationDate: Date
  statusMarkers: [String!]!
  # act↔MO correlation contract (06 consumes; populated by the loader):
  moPart: Int
  moNumber: String
  moDate: Date
}

type LegalActSummary {
  description: String
  summary: String
  plainLanguageSummary: String
  documentCategory: String
  domains: [String!]!
  affectedAudiences: [String!]!
  keywords: [String!]!
  keyDates: JSON
  penaltiesMentioned: Boolean
  fiscalImpact: String
  confidence: Float
}

type LegalCitationKey { actType: String!  actNumber: String!  actYear: Int!  issuerSlug: String! }

type LegalReferenceEdge {
  sourceDocumentId: String!           # edge PK part 1 (act_references PK); stable connection key
  refIndex: Int!                      # edge PK part 2
  relation: LegalRelation!
  targetRaw: String!
  targetClass: String!
  targetAct: LegalAct                 # resolved domestic (DataLoader by act_id)
  targetExternalAct: LegalExternalAct
  targetFragment: String
  resolution: String!
  confidence: Float
  sourceAct: LegalAct                 # for incoming edges
}
type LegalReferenceConnection { edges: [LegalReferenceEdge!]!  pageInfo: PageInfo!  totalCount: Int }

type LegalStatusEvent {
  eventKind: String!
  effectiveDate: Date
  sourceAct: LegalAct
  evidence: JSON!
  eventSource: String!                # 'portal' | 'monitorul-oficial' (06 contributes rows; this type reads both)
}

type LegalNode {
  nodeId: BigInt!
  documentId: String!
  nodeKind: String!
  label: String
  numberKey: String
  path: String!
  orderIndex: Int!
  charStart: Int
  charEnd: Int
}

type LegalExternalAct { externalActId: BigInt!  identityKey: String!  displayCitation: String!  kind: String! }

type LegalSectionHit {
  act: LegalAct!
  documentId: String!
  sectionKey: String!
  articleNumber: String
  nodeLabel: String
  nodePath: String
  charStart: Int                      # forward-compat locator (not served text — §3.4)
  charEnd: Int
  snippet: String                     # grounded snippet from document_summaries (node text is P2)
  portalDeepLink: String
  score: Float!
}

type LegalSearchResult {
  acts: [LegalAct!]!
  sections: [LegalSectionHit!]!
  caveats: [String!]!                 # §5.2-C honesty + semantic-gate caveats
}

type LegalActConnection { edges: [LegalActEdge!]!  pageInfo: PageInfo!  totalCount: Int }
type LegalActEdge { node: LegalAct!  cursor: String! }

input LegalActFilter {                # §7 — generated from the filter spec
  actType: [String!]
  issuerSlug: [String!]
  domain: [String!]
  category: [String!]
  status: [LegalActStatus!]
  year: Int
  yearFrom: Int
  yearTo: Int
  penaltiesMentioned: Boolean
  fiscalImpactPresent: Boolean        # isNull op on fiscal_impact
  q: String                           # trigram on citation (list); Meili-backed in search
  exclude: LegalActExcludeFilter
}
input LegalActExcludeFilter { actType: [String!]  issuerSlug: [String!]  domain: [String!]  status: [LegalActStatus!] }

extend type Query {
  legalAct(actId: BigInt, citation: String): LegalAct
  legalActs(filter: LegalActFilter, sort: LegalSortKey = IN_DEGREE, dir: SortDir = DESC, first: Int = 20, after: String): LegalActConnection!
  legalSearch(q: String!, filter: LegalActFilter, channel: String = "auto", includeHistorical: Boolean = false, limit: Int = 20): LegalSearchResult!
  legalExternalAct(externalActId: BigInt!): LegalExternalAct
}
```

### 6.2 `Entity` extension

**None in v1.** Legal has no per-CUI slice (§2.2). When `issuer_slug→institution`
lands, this module adds `extend type Entity { actsIssued: LegalActConnection! }`
via the contributor's `profileSlice`. Documenting the deliberate absence is part
of the §9 skeleton contract so 06 knows legal does not contribute an `Entity`
field yet.

### 6.3 DataLoaders

- `actById` — batches `findActsByIds` (incoming-edge `sourceAct`, `targetAct`,
  status-event `sourceAct` fan-out → one query). Key = `act_id` string.
- `summaryByDocumentId`, `canonicalByActId` — batch the act-card lazy fields.
- Resolvers are thin: parse args → call the usecase → map. No business logic
  in resolvers (§6.2). The connection cursor reuses the kernel encoder (§14.3).

### 6.4 Schema-merge conflict gate (§14.8)

All types are `Legal*`; no bare generic names. The kernel CI conflict test
(stitched schema must not throw on duplicate type/field) covers the
portal↔MO boundary: `Legal*` vs `Mo*` cannot collide. **`LegalStatusEvent`,
`LegalAct`, `LegalDocument` are defined once here (the `acts/` area)**; the `mo/`
area references `LegalAct` by name (e.g. `MoActPublication.act: LegalAct`) but
never redeclares it.

**Cross-area type extensions — the `mo/` area's `LegalAct` fields.** The `mo/`
area (06) adds the act→gazette fields to the portal-owned base type via `extend
type LegalAct { gazettePublications: [MoActPublication!]!  gazetteStatusEvents:
[MoStatusEvent!]!  gazetteInEdges: [MoLifecycleEdge!]! }` (the authoritative
3-field gazette set per 06 §6 and foundation §9 — `gazettePublications` resolved
through `mo_act_publications.act_id`; `gazetteStatusEvents` through
`act_status_events` where `event_source = 'monitorul-oficial'`; `gazetteInEdges`
through `mo_lifecycle_edges` by `target_act_id` — §13). Because both areas are stitched *inside*
`makeLegalModule` before the module's typedefs are contributed, these extensions
are local SDL composition, not a cross-module schema merge — the kernel conflict
test (duplicate type/field) does not flag added fields, only duplicate
declarations. For the consistency pass: these `LegalAct` extension fields are
owned by the `mo/` area (resolvers in its resolver map, not `acts/`); the `acts/`
area declares `type LegalAct` once and never extends it. The `mo/` area must not
redeclare `type LegalAct`, only `extend` it, and every field it adds must be
`Mo*`-typed (`MoActPublication`, `MoStatusEvent`) — never a bare or `Legal*` type.

---

## 7. Filters (priority area)

One **collection filter spec** per filterable collection, declared once; the
kernel derivers (`toTypeBox`/`toGraphQLInput`/`toConditionBuilders`/
`canonicalizeFilters`, §14.2) produce REST schema + GraphQL input + SQL + cache
key. The module **declares specs; it does not invent a DSL.**

### 7.1 `legal_acts` collection spec (the shared legal families — §9)

The four shared legal filter families (`act_type`, `issuer`, `domain`, `year`)
defined here are the skeleton 06 reuses for its MO collections. Declared as a
concrete `CollectionFilterSpec` literal (the module **declares**; the kernel
derivers compile — §14.2):

```ts
// legal/shell/filters/legal-acts.spec.ts  — alias 'a' = acts, 's' = canonical document_summaries
export const legalActsSpec: CollectionFilterSpec = {
  collection: 'legal_acts',
  fields: [
    { name: 'actType',            type: 'enum', ops: ['in'],     column: { alias: 'a', column: 'act_type' },      array: true, exclude: true,  enumValues: ACT_TYPE_VALUES },
    { name: 'issuerSlug',         type: 'string', ops: ['in'],   column: { alias: 'a', column: 'issuer_slug' },   array: true, exclude: true },
    { name: 'status',             type: 'enum', ops: ['in'],     column: { alias: 'a', column: 'status' },        array: true, exclude: true,  enumValues: STATUS_VALUES },
    { name: 'year',               type: 'int',  ops: ['eq'],     column: { alias: 'a', column: 'act_year' } },
    { name: 'yearFrom',           type: 'int',  ops: ['gte'],    column: { alias: 'a', column: 'act_year' } },
    { name: 'yearTo',             type: 'int',  ops: ['lte'],    column: { alias: 'a', column: 'act_year' } },
    { name: 'domain',             type: 'enum', ops: ['in'],     column: { alias: 's', column: 'domains' },          array: true, exclude: true, enumValues: DOMAIN_VALUES },     // GIN array containment
    { name: 'category',           type: 'enum', ops: ['in'],     column: { alias: 's', column: 'document_category' }, array: true, exclude: true, enumValues: CATEGORY_VALUES },
    { name: 'penaltiesMentioned', type: 'bool', ops: ['eq'],     column: { alias: 's', column: 'penalties_mentioned' } },
    { name: 'fiscalImpactPresent',type: 'bool', ops: ['isNull'], column: { alias: 's', column: 'fiscal_impact' } },  // true ⇒ IS NOT NULL, false ⇒ IS NULL
    { name: 'q',                  type: 'string', ops: ['contains', 'prefix'], column: { alias: 'a', column: 'display_citation' } }, // engine-backed (§7.2)
  ],
  sort: { default: 'in_degree', allowed: ['in_degree', 'act_year', 'entry_into_force', 'display_citation'] },
};
```

- **`ACT_TYPE_VALUES`** is resolved at boot from **`distinct legal.acts.act_type`**
  (lege, oug, og, hotarare, ordin, decizie, decret, decret-lege, …) — **NOT** from
  `document_summaries.document_category`. The two are *different vocabularies*
  (`act_type` is the legal instrument; `document_category` is the AI-assigned
  category like `hotarare-de-guvern`/`norma-metodologica`). `CATEGORY_VALUES`
  resolves from the 13-value `document_category`; `DOMAIN_VALUES` from the 16-value
  controlled `domains`. They are independent filter fields and must never be
  cross-validated.
- **Year range as two fields** — modelled as `yearFrom` (`gte`) + `yearTo`
  (`lte`) over the same column. (The kernel `FilterOp` union *does* include
  `between` per foundation §14.2; the two-field form is a deliberate ergonomics
  choice here, not a limitation.)
- **`isNull` is mandatory (§14.2)** — `fiscalImpactPresent` carries `ops:['isNull']`
  where the bool *value* selects `IS NOT NULL` (true) vs `IS NULL` (false); this is
  a value, not a negation, so it does not use the `exclude:` mechanism.
- **Negation only on `exclude:true` fields** (actType/issuerSlug/status/domain/
  category) — no universal symmetric negation.

**Join discipline (BINDING for the list query):** `domain`, `category`,
`penaltiesMentioned`, `fiscalImpactPresent` live on `document_summaries` (alias
`s`), keyed by `document_id`, not on `acts` (alias `a`). The kernel
`toConditionBuilders` composes **WHERE conditions only** (§14.2) — it does not add
joins. Therefore the acts list query's FROM is **fixed and unconditional**:
`legal.acts a LEFT JOIN legal.act_documents d ON d.act_id=a.act_id AND
d.is_canonical LEFT JOIN legal.document_summaries s ON s.document_id=d.document_id`.
The canonical predicate is in the JOIN, so a multi-document act contributes
exactly one summary row (no double-count) regardless of which filters are active.
Pure `act_type/year/status` queries pay the LEFT JOIN but it is cheap (PK/unique
index on both sides). **This is a fixed multi-table FROM that the shared composer
supports via the spec's per-field `alias`; legal does not need a module-local
query builder.** 06 inherits the same canonical-join discipline for its MO
collections.

### 7.2 Which engine backs `q`

| Surface | `q` engine | Why |
|---|---|---|
| R1 `/legal/acts` list | **pg_trgm** on `display_citation` (fallback) / **Meili** when up | identity/prefix autocomplete (act citations); kernel `SearchClient.multiSearch` on the `legal_acts` Meili index |
| R7 `/legal/search` | **hybrid**: Meili (act identity) + OpenSearch (BM25, romanian analyzer) + pgvector (semantic), fused RRF | provision questions + topical (§4 multi-channel) |
| R8 `/legal/filters/resolve` | trigram + distinct-value lookup | name→value resolution |

Postgres `ILIKE`/trigram is the **always-available fallback** when Meili/OS/
semantic are down (foundation §4.5) — R1/R7 degrade, never error.

### 7.3 Discovery / resolve dimensions (R8 + MCP discovery tool)

`dim ∈ { act, issuer, domain, category, act_type, status }`:
- `act` → resolve "legea 227/2015"/"codul fiscal" → `{actId, displayCitation}`
  (reuse the loader's identifier regex via citation keys + aliases).
- `issuer` → distinct `issuer_slug` + display name (trigram on Romanian name,
  diacritics-folded — handles the cedilla/comma duplicates, NOTES §1.2).
- `domain`/`category`/`act_type`/`status` → the closed vocab with counts.

### 7.4 Golden question→filter cases (from `AI_AGENT_FILTER_QUESTION_CATALOG.md`)

| Catalog | Question | Compiled filter / call |
|---|---|---|
| LG-5 | "Acts in domain D, type T, status S, year Y" | R1 `domain=[D]&actType=[T]&status=[S]&year=Y` |
| LG-3 | "Status of act X + evidence" | R2 `:idOrCitation` → `status`+`statusEvidence`+`timeline` |
| LG-2 | "What amended/repealed act X?" | R4 `:id/links?direction=in&relation=modifica,abroga,completeaza` |
| LG-1 | "What does X cite / who cites X?" | R4 `direction=out` and `direction=in` |
| LG-4 | "Which article answers Q?" | R7 `/legal/search?q=Q&channel=sections&status=in-vigoare` → `LegalSectionHit[]` w/ node label + char offsets |
| — | "Laws about fiscal matters in force, with penalties" | R1 `domain=[fiscal-si-bugetar]&status=[in-vigoare,modificat]&penaltiesMentioned=true` |

---

## 8. MCP tools

`legal/shell/mcp/`. TypeBox input+output; handler calls a usecase; output is the
structured `{ ok, kind, query, link, item|items, summary? }` (§6.3). Rate-limited;
bounded result sizes. Two families minimum (§6.3): one discovery + query tools.

### 8.1 Discovery — `resolve_legal_filters`
```
in:  { dim: 'act'|'issuer'|'domain'|'category'|'act_type'|'status', q: string, limit?: int }
out: { ok, kind:'filter_resolution', query, items:[{value,label,count?}], summary }
```
Calls `resolveLegalFilters`. `link` → client `/legal?<dim>=<value>`.

### 8.2 Query tools

| Tool | Input | Usecase | Output `kind` | `link` | `summary` template |
|---|---|---|---|---|---|
| `get_legal_act` | `{ actId?, citation? }` | `getAct` | `legal_act_card` | `/legal/acts/<actId>` | "{citation} — status: {status}; modificat de {amendedAfterPublication} acte." |
| `search_legal_acts` | `{ q, filter?, channel?, includeHistorical?, limit? }` | `searchLegal` | `legal_search` | `/legal/search?q=…` | "{n} acte / {m} secțiuni pentru „{q}". {caveats}" |
| `get_legal_act_links` | `{ actId\|citation, direction, relation?, since?, limit? }` | `getActLinks` | `legal_links` | `/legal/acts/<id>/links?…` | "{n} {relation} edges for {citation}." |
| `get_legal_act_timeline` | `{ actId\|citation }` | `getActTimeline` | `legal_timeline` | `/legal/acts/<id>/timeline` | "{citation}: {n} events from {first} to {last}." |
| `get_legal_node` | `{ documentId, path }` | `getActTree`+node | `legal_node` | `/legal/acts/<id>/tree?path=…` | returns label + kind + char range + portal deep link (node TEXT is not in prod — P2; see §13) |

Tool naming follows `<verb>_legal_<noun>` (§6.3). `search_legal_acts` returns
**citations with the grounded snippet + node locator** (act + node label + char
range + `summary`-derived snippet + portal deep link) so agent answers are
verifiable and cite the right provision — *without* claiming to serve full node
text the server cannot read (§3.4). It **never** computes totals/rankings beyond
the graph edge counts it can ground (catalog Core Rule: search resolves
candidates; graph answers come from `act_references`).

---

## 9. Search integration

**Owned `doc_type`s** (§4.5, verified live):
- `legal_act` (223,611) — one row per act: `title`=display_citation+den,
  `body`=summary/semantic_text, `cuis`=`{}` (no CUI), `doc_date`=entry_into_force,
  `attrs`={status, domains, category, in_degree, aliases}. → **Meili** index
  `legal_acts` (autocomplete/identity, rank by `in_degree`), **OpenSearch**
  `legal_acts` (topical BM25).
- `portal_section` (2,938,113) — one row per section: `title`=act citation +
  article label, `body`=section text, `attrs`={article_number, node_path,
  status, domains}. → **OpenSearch** `legal_sections` (BM25, romanian analyzer)
  for the lexical channel of hybrid RRF; the **vector channel** is
  `legal.section_embeddings` HNSW directly (pgvector), not OpenSearch vectors
  (deferred, NOTES decision #4).

The scrapper `search` lane writes these rows; **the server only reads/queries**
(`search.documents` is the rebuildable projection + ILIKE fallback). Index names:
Meili `legal_acts`; OpenSearch `legal_acts` + `legal_sections`.

**Semantic gating (§14.5):** the kernel's platform `SearchCapabilities` probe
targets `search.documents`, which has **no vector column** (verified live) — so
that probe alone would report `semantic=false` and legal's HNSW would never
activate. **Resolution (BINDING):** the legal module contributes its **own**
capability probe at boot — `semantic = (vector ext present) AND (legal.section_embeddings
HNSW index present)` — into a per-domain `SearchCapabilities` slot, rather than
depending on the kernel's `search.documents` probe. When its slot is false:
`/legal/search` `channel` is forced lexical, `caveats:["semantic search
unavailable"]`, semantic GraphQL paths return `null`. Live today the legal HNSW
indexes (`document_embeddings_general_v1_hnsw`, `section_embeddings_article_v1_hnsw`)
exist, so the default path is hybrid.

**Corpus-completeness caveat:** `portal_section` / `legal.section_embeddings`
coverage depends on the raw section-embedding campaign drain state (NOTES gotcha:
parity is warning-class while the campaign catches up), and 12.7% of standard-article
docs have parser-v1 node gaps (§1). The retrieval surface must **not assume every
act has section vectors** — acts without sections fall back to the doc channel,
and a section-channel miss is a degraded result, not an error.

**Hybrid fusion (RRF, research §4):** identifier router first (regex act-citation
parse → direct `resolveActRef`, no embeddings); else fuse Meili (act identity) +
OpenSearch BM25 (sections) + pgvector section HNSW with reciprocal-rank fusion
(no score calibration). Parent-document retrieval: section hit → act card +
node breadcrumb.

---

## 10. Sync / freshness impact on serving

- Loader cadence (NOTES §"Sync strategy"): `portal-legislativ:load-prod` runs
  after each crawl+enrichment batch (manual/cron); idempotent, convergent.
  Amendments to **existing** acts arrive via **new** acts' outgoing edges, so a
  load run refreshes status + graph for old acts automatically.
- **As-of semantics:** `acts.status` is a fold(events, as_of=today) — the API
  surfaces it as the current status and **always** attaches the §5.2-C honesty
  payload (`amendedAfterPublication` + status badge). Future-dated abrogations
  are events, never current status.
- **Cache TTL:** no loader-completion version stamp exists for legal yet →
  **interim TTL-only** (§14.11), TTLs per §5. When a `system_control`/`etl`
  watermark for the legal load lands, busy-bust + surface it as the domain
  freshness "as-of" on every read.
- Search projections rebuild from prod on loader runs (research §5.3); the server
  treats Meili/OS/HNSW as rebuildable and never authoritative.

---

## 11. Wiring

```ts
// legal/index.ts
export interface LegalModuleDeps {
  db: Kysely<ProdDatabase>;
  search: SearchClient;          // kernel meili+os
  synthetic: SyntheticClient;    // kernel embeddings (search_query: prefix)
  capabilities: SearchCapabilities;
  cache: Cache; logger: Logger;
}
export function makeLegalModule(deps: LegalModuleDeps): LegalModule {
  // acts area repos: LegalActsRepo (extends LegalRepoBase), LegalGraphRepo, LegalTreeRepo, LegalRetrievalRepo
  // mo area (06): makeMonitorulSurface(deps) — composed in here
  // returns { restPlugin, graphql:{typeDefs, resolvers}, mcpTools,
  //           contributor: moContributor /* source:'monitorul-oficial', from the mo/ area, §4 + 06 A5; acts/ adds none in v1 */,
  //           repos }
}
```
**`legal` is ONE module with two authoring areas, not two modules** (resolves the
foundation §2/§10 "a source module never imports another source module" tension).
Because portal and MO co-own `src/modules/legal/` (foundation §9), there is no
*inter-module* import: both live inside the single `legal` module and share its
`core/` via ordinary intra-module imports. The internal layout:

```
src/modules/legal/
  core/repo-base.ts        # LegalRepoBase (05 owns) — resolveActRef, getStatusEvents, findActsByIds
  core/types.ts            # LegalAct + all Legal* view models (05 owns)
  acts/                    # 05: LegalActsRepo, LegalGraphRepo, LegalTreeRepo, LegalRetrievalRepo, acts REST/GQL/MCP
  mo/                      # 06: MO repos + Mo* REST/GQL/MCP (extends, never redefines core/)
  index.ts                 # ONE makeLegalModule(deps) wires BOTH acts + mo and returns one module
```

`makeLegalModule(deps)` is the **single** factory; it constructs the acts repos
and the MO repos (the MO repos take `LegalRepoBase` by ordinary constructor
injection inside the same module — not a cross-module import) and returns one
`{ restPlugin, graphql, mcpTools, contributor, repos }`. This keeps foundation
§10 "modules don't depend on each other" intact: from `build-app.ts`'s view there
is exactly one `legal` module to register.

- **Env additions:** none beyond kernel (`PROD_DATABASE_URL`, `MEILI_*`,
  `OPENSEARCH_URL`, `SYNTHETIC_*`, `EMBEDDING_MODEL`). Legal needs the nomic
  embedding model + `search_query:`/`search_document:` prefixes (kernel
  synthetic-client already does this).
- **build-app registration:** kernel built first; `makeLegalModule(deps)` once;
  register its REST plugin under `/api/v1/legal`, merge its GraphQL slice (acts
  typedefs + MO type-extensions stitched together inside the module before
  contribution), register its MCP tools, and register the module's **one
  contributor** — the `mo/` area's issuer-keyed MO contributor (06/A5). The
  **acts/ area registers no contributor** in v1 (§4 — no per-CUI legal-acts slice
  until the `issuer_slug→institution` axis lands).
  Order is data-independent — `legal` does not depend on any other module.
- **Legacy superseded:** none.

---

## 12. Testing

- **Unit** (`tests/unit/legal/`): `searchLegal` channel routing (identifier router
  vs section vs doc) with mocked ports; status-badge `amendedAfterPublication`
  derivation; filter spec → SQL snapshot (the unconditional canonical-join FROM +
  `act_type`-vs-`category` vocabulary separation of §7.1); cursor encode/decode +
  **`act_id`-tiebreaker stability** (no skip/dup across pages on `in_degree=0`
  ties) + `fhash` mismatch → `InvalidInput`; act-ref resolution
  (citation/alias/numeric).
- **Integration** (`tests/integration/legal/`): REST+GraphQL+MCP against a
  seeded `legal.*` fixture; **tri-surface equivalence** — same filter →
  identical acts across the three (the `canonicalizeFilters` contract, §14.2);
  semantic-gate-off path returns lexical results + caveat (no error);
  `act_documents` canonical-only serving (a stub doc is never returned as text).
- **Golden filters:** the §7.4 table as integration cases; plus the research §3.3
  16-query retrieval gold set wired as an MRR/hit@k smoke (read-only, asserts the
  section channel out-ranks doc channel for big-code provision queries).
- **Privacy:** N/A (no PII in legal) — a one-line assertion that no party/PII
  column exists in any `legal.*` row type (trivially true; documents the
  invariant for the consistency pass).

---

## 13. Open questions / risks

1. **act↔MO correlation contract (HANDOFF TO 06).** Two paths exist, and **the
   FK is authoritative, not the typed columns:**
   - **Authoritative:** `legal.mo_act_publications.act_id` (FK → `legal.acts`,
     `ON DELETE SET NULL`) — 06 owns this table and resolves publications to
     acts. The act→publication direction is `mo_act_publications WHERE act_id=$1`
     (index `mo_act_publications_act_idx`). **06 adds the gazette field set
     (`gazettePublications`, `gazetteStatusEvents`, `gazetteInEdges`) via
     `extend type LegalAct` — portal defines the base type, 06 extends it (the
     reconciled multi-field extension; see foundation §9).**
   - **Typed columns** `act_documents.(mo_part, mo_number, mo_date)` are the
     parsed-from-citation hint, but **populated on only 3 of 225,401 docs today**
     (NOTES gotcha: `parsePublication` defaulted `mo_part` only when `Partea`
     was explicit; the `mo_part=1` default fix needs a non-dry `acts`-stage
     reload that was never run). **The server must NOT rely on these columns for
     correlation** — expose them as best-effort `LegalDocument.moPart/moNumber/
     moDate` (often null) and route real act↔gazette joins through
     `mo_act_publications.act_id`. **Risk:** if a consumer assumes the typed
     columns are the contract, correlation silently returns ~nothing. Flagged for
     the orchestrator + 06. *Recommend:* a scrapper reload to backfill the typed
     columns (out of server scope) OR 06's `mo_act_publications` is the sole join
     path (server-side, no reload needed) — **recommend the latter for v1.**
2. **No CUI / no `Entity.legal` in v1** (§2.2). Entity-360 does not include legal
   until `issuer_slug→institution` lands. Confirm this is acceptable for the v1
   cross-source surface (it matches the brief's "defer the join").
3. **Node text is not in `transparenta_prod` (resolved for v1; one decision
   remains).** v1 grounds RAG/MCP answers on the `document_summaries`
   `summary`/`semantic_text` snippet + a portal deep link (§3.4/§3.5); char
   offsets are a forward-compat locator, never served as text. **Decision for a
   later phase:** project node text into prod (a `legal.node_texts` table) for
   true article-passage serving. *Recommend:* a P2 scrapper projection (keeps the
   server single-DB). The orchestrator should confirm the v1 snippet-grounding is
   acceptable as the interim RAG answer shape.
4. **`acts(status, in_degree desc, act_id)` index — recommended pre-launch
   scrapper migration** (not "earned if slow"). R1's default sort is `in_degree
   desc`, so the workload is guaranteed on day one; the API cannot create the
   index (read-only). The orchestrator should request this migration in the
   scrapper before launch.
5. **`document_summaries.domains` GIN** lives on the summary table keyed by
   `document_id`; domain-filtered list queries pay the (unconditional) canonical
   `is_canonical` LEFT JOIN + array containment. Verify selectivity on the
   16-value vocab; for the common domains (administratie 110k) the planner may
   favor a seq scan — measure before promising sub-second domain lists.
6. **Semantic deviation from foundation §4.5 (resolved by a module-local probe).**
   Vector is live for legal but absent from the kernel `search.documents` probe,
   so the legal module contributes its own `SearchCapabilities.semantic` probe
   over `legal.section_embeddings` HNSW (§9). The orchestrator should confirm the
   kernel exposes per-domain capability slots (or accept a module-local override),
   else semantic silently never activates platform-wide.
7. **Hub fan-out** (Legea 47/1992, 23,527 in-edges): all graph reads bounded;
   confirmed in §3.3. No unbounded traversal in any surface.
