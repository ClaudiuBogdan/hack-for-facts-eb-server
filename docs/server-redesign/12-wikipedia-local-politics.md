# 12 — wikipedia-local-politics (council composition + mayors + BEC-2024)

> **Status: FORWARD-LOOKING / NOT IMPLEMENTABLE YET.** This is a _target-state_
> plan for an eventual `local-politics` server module. **Nothing in this plan is
> servable today** and no part of it may be built until the
> [serving-promotion prerequisite](#0-serving-promotion-prerequisite-read-first)
> is met.
>
> **Data status: RAW-ONLY / STAGING.** The source data lives **only** in the raw
> cluster (`transparenta_eu_primarii_transparency`, schema
> `primarii_wikipedia_politics`). It is **absent from the serving DB
> `transparenta_prod`** — confirmed live on 2026-06-16: `\dn` lists `budget,
budget_staging, companies, core, etl, flows, justice, legal, parliament, pnrr,
primarii_transparency, procurement, search, system_control` — **no
> `wikipedia`/`local_politics`/`primarii_wikipedia_politics` schema in serving.**
>
> **Authority status: PROVISIONAL / NON-AUTHORITATIVE.** This is
> **source-attributed STAGING, not canonical officeholder identity.** Every
> council-seat and mayor _claim_ row carries `accepted_for_map = false`. BEC-2024
> validates **party presence and votes, NOT exact seat allocation** — the seat
> counts are Wikipedia's. The API contract below makes this caveat **structural
> and unavoidable** (every record is labelled provisional; nothing is presented
> as fact). See [§13 Open questions / risks](#13-open-questions--risks) for the
> exact gate that must be cleared before promotion.

Conforms to [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md)
(topology §2, DB contract §3, kernel territory hub §4.2, scalars §14.1, filter
pipeline §7/§14.2, GraphQL namespacing §14.8, REST/GraphQL/MCP §6, privacy §8.2).
Where this source diverges (it has **no CUI**, it is **not in serving**, and it
is **non-authoritative**), it states so explicitly and gates the divergence.

---

## 0. Serving-promotion prerequisite (READ FIRST)

This module **cannot be built** until a scrapper-side **promotion slice** lands
the data into `transparenta_prod`. That slice is **out of scope for this
server-side plan** but is its hard precondition. The promotion slice must, at
minimum:

1. **Create a serving schema** (proposed name `local_politics`, see §1) in
   `transparenta_prod` via a scrapper Kysely prod-migration, and a loader lane
   that projects the raw `primarii_wikipedia_politics.*` tables into it.
   Per foundation §F5, **the server never migrates or writes** — this is the
   scrapper's job.
2. **Resolve the territory key.** The raw layer already derives a
   `resolved_siruta` per entity (3,187/3,187 coverage: 3,159 infobox + 28
   CUI-map; runbook in `WIKIPEDIA_LOCAL_POLITICS_NOTES.md`). The loader must
   **canonicalize it to `core.territories.territorial_siruta_code`** (text) so
   every served row links the kernel territory hub (§4.2). This is the **strong
   correlation** and the spine of the whole module.
3. **Preserve the staging/authority flags** verbatim: `accepted_for_map`,
   `match_status`, `party_match_status`, `name_match_status` must survive into
   serving columns so the API can label every row provisional.
4. **Decide the org/CUI linkage** (open question — §13): the raw `entities`
   table is keyed by **CUI** (the UAT's public-entity CUI), so unlike most
   "no-CUI" sources this source _does_ have a CUI anchor at the UAT grain. The
   loader should link `entities.cui` → `core.organizations` / `core.public_entities`
   **by CUI** (link-not-merge, §4.1) so the module can register a kernel
   contributor (§4.4) and contribute an `Entity` extension (§6.2). **This is the
   only CUI in the source** — council members and mayors are **persons with no
   CUI** and MUST NOT be invented one.
5. **Pass a two-tier validation gate** in the loader (foundation §4 / decision
   #4) and produce a serving freshness watermark (run id + dataset digest) the
   API can surface (§10).
6. **Regenerate the kernel `ProdDatabase` types.** Foundation §3 enumerates the
   served schemas (`core/flows/search/budget/companies/parliament/legal/pnrr/
justice/procurement/primarii_transparency`) — **`local_politics` is not among
   them today.** The promotion slice must add the new schema to the kernel's
   generated DB-type definition so the typed Kysely instance (§11) covers
   `local_politics.*`. Until then the module cannot type-check.

Until that slice is merged and verified, **every data-dependent section below is
marked `DEFERRED — pending serving promotion`** and the row counts quoted are
**raw-layer counts** (the eventual serving counts may differ after dedup /
acceptance filtering).

---

## 1. Summary & data status

**What exists today (RAW only, not served):** raw DB
`transparenta_eu_primarii_transparency`, schema `primarii_wikipedia_politics`
(+ `_control`), import run `20260518`, dataset digest
`64d25a33145b9d5a84f389a2d435bb408e9152de7fbf20afc031780d8df026c7`. Raw counts
(from `WIKIPEDIA_LOCAL_POLITICS_NOTES.md`, validated zero-drift across PG17.9
local ↔ PG18.4 prod-raw):

| Raw table                 | Grain                        |   Rows | Notes                                                                        |
| ------------------------- | ---------------------------- | -----: | ---------------------------------------------------------------------------- |
| `entities`                | UAT (PK `cui`)               |  3,187 | derived `resolved_siruta` 100%; `has_council_table`/`has_mayor_row`          |
| `council_composition`     | `(cui, table_id, row_index)` | 10,932 | party-seat rows; **`accepted_for_map=false`**; 25 dup-table cases            |
| `mayors`                  | `(cui, table_id, row_index)` |  3,156 | raw mayor text + parsed guesses; **`accepted_for_map=false`**                |
| `bec_council_correlation` | `(cui, table_id, row_index)` | 10,932 | 10,857 matched / 75 no_match; `bec_vote_share`, votes bigint, `match_status` |
| `bec_mayor_correlation`   | `(cui, table_id, row_index)` |  3,156 | 109 party_no_match / 50 name_no_match                                        |
| `research_complements`    | `row_sha256`                 |    326 | GPT-research complements; **`accepted_for_map=false`**                       |
| `missing_entities`        | `row_sha256`                 |    307 | review list                                                                  |
| `party_label_review`      | `row_sha256`                 |    279 | review list                                                                  |
| `source_files`            | `file_key`                   |      8 | sha256 + row_count provenance                                                |

**What's deferred:** **everything** — there is no serving schema, no API, no
search projection, no MCP tool, no client route. This plan defines the _target
shape_ only.

**Source's prod schema(s):** none yet. Proposed serving schema:
**`local_politics`** in `transparenta_prod` (created by the promotion slice §0).
Kernel schemas consumed: `core` (territory hub §4.2; org hub §4.1 by CUI at UAT
grain only), `search` (read-only projection §9). **Not** consumed: `flows`
(this source has **no money flow** — §4 declares no `flow_type`).

---

## 2. Schema → domain model

> **DEFERRED — pending serving promotion.** The column names below are the
> **proposed** serving columns (the loader projects raw → these); they are not
> live. Final names are fixed by the promotion-slice migration, and this section
> must be reconciled against `_prod-schema/local_politics.tsv` once it exists.

Proposed serving tables in `local_politics` (denormalized for read, territory
linked by SIRUTA, no PII beyond publicly-published officeholder names — see
privacy note below):

| Proposed serving table                            | Maps from raw                                     | Module view model (`core/types.ts`) |
| ------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| `local_politics.uats`                             | `entities`                                        | `LocalPoliticsUat`                  |
| `local_politics.council_seats`                    | `council_composition` ⨝ `bec_council_correlation` | `LocalPoliticsCouncilSeat`          |
| `local_politics.mayors`                           | `mayors` ⨝ `bec_mayor_correlation`                | `LocalPoliticsMayor`                |
| `local_politics.party_summaries` (derived rollup) | grouped `council_seats`                           | `LocalPoliticsPartySummary`         |

```ts
// local-politics/core/types.ts  (PROPOSED — domain-prefixed per §14.8)
export interface LocalPoliticsUat {
  readonly cui: string; // entities.cui — the ONLY CUI; UAT grain
  readonly sirutaCode: string; // canonicalized → core.territories.territorial_siruta_code (§4.2)
  readonly name: string;
  readonly countyName: string | null; // denormalized; canonical metadata via territory hub
  readonly hasCouncilTable: boolean;
  readonly hasMayorRow: boolean;
  readonly resolvedSirutaInBec: boolean; // 1 UAT (Bucharest) is absent from BEC
  readonly sourceRunId: string; // provenance / "as-of" (§10)
  readonly pageRevisionId: string | null; // Wikipedia change signal
}

export interface LocalPoliticsCouncilSeat {
  readonly cui: string; // UAT CUI
  readonly sirutaCode: string;
  readonly partyLabel: string; // Wikipedia's party label (provisional)
  readonly seats: number; // Wikipedia's seat count (NOT BEC-validated)
  readonly becMatchStatus: 'matched' | 'no_match' | string; // staging signal (open enum §1.4 NOTES)
  readonly becVoteShare: string | null; // numeric → string (§14.1 money/numeric rule)
  readonly becVotes: string | null; // bigint → string (§14.1)
  readonly acceptedForMap: false; // STRUCTURAL: always false in staging (§1.5)
  readonly provenance: ProvenanceStamp; // see below
}

export interface LocalPoliticsMayor {
  readonly cui: string;
  readonly sirutaCode: string;
  readonly mayorNameRaw: string; // publicly-published elected official name (see privacy note)
  readonly mayorNameParsed: string | null;
  readonly partyLabelParsed: string | null;
  readonly becWinnerParty: string | null;
  readonly partyMatchStatus: string; // 'matched' | 'party_no_match' | ...
  readonly nameMatchStatus: string; // 'matched' | 'name_no_match' | ...
  readonly acceptedForMap: false;
  readonly provenance: ProvenanceStamp;
}

// shared envelope every served local-politics record carries (§ enforces the caveat)
export interface ProvenanceStamp {
  readonly source: 'wikipedia';
  readonly authority: 'provisional'; // CONSTANT — never 'authoritative'
  readonly becValidated: 'party_presence_only'; // BEC validates presence/votes, NOT seat allocation
  readonly sourceRunId: string; // '20260518'
  readonly pageRevisionId: string | null;
}
```

**Identity (CUI) linkage:** **UAT grain only.** `uats.cui` links the kernel
identity hub (§4.1) by CUI (link-not-merge). **Council members and mayors are
persons and have NO CUI; never synthesize one.** The module's `Entity`
contribution (§6) is the UAT's _local-politics presence_, not a person.

**Territory (SIRUTA) linkage:** `siruta_code` (text) → `core.territories.
territorial_siruta_code`. **This is the primary join and the primary filter
dimension** (§7). All geographic filters resolve through the kernel territory
hub (foundation §4.2) — the module never reads `core.territories` directly for
filtering; it composes the kernel `TerritoryFilter` family.

**Correlation with `primarii-transparency` (module 11-direction):** both modules
are keyed at **UAT/CUI + SIRUTA**. A council/mayor row and a transparency
snapshot for the same UAT join on `cui` (and/or `siruta_code`). **Cross-module
composition happens in the kernel** (a `core/usecases` UAT-360 that fans out to
both contributors), **never** by one module importing the other (foundation §2
rule). This module exposes its slice; the kernel correlates.

**PII / excluded columns:** council members are **not** enumerated by name in the
raw data (only party-seat counts), so there is no member-PII surface. **Mayor
names** are names of **publicly elected officials published on Wikipedia** —
public-figure data, not private PII — so they are servable, but **always behind
the `provisional` authority stamp**. The review tables (`missing_entities`,
`party_label_review`, `research_complements`) are **internal data-quality
artifacts** and are **excluded from all default projections** (they may back an
admin/debug-only filter-resolve dimension at most — §7.4). No `*_private` tables
exist in this source.

---

## 3. Repo interface (ports)

> **DEFERRED — pending serving promotion** (the repo cannot be implemented
> against a non-existent serving schema). Signatures are the target contract.

```ts
// local-politics/core/ports.ts  — all methods return Result<T, ApiError> (neverthrow, §5.1)
export interface LocalPoliticsRepo {
  // UATs
  getUat(cui: string): Promise<Result<LocalPoliticsUat | null, ApiError>>;
  getUatBySiruta(siruta: string): Promise<Result<LocalPoliticsUat | null, ApiError>>;
  listUats(f: UatFilterInput, page: OffsetPage): Promise<Result<Paged<LocalPoliticsUat>, ApiError>>;

  // council composition (the headline surface)
  listCouncilSeats(
    f: CouncilFilterInput,
    page: OffsetPage
  ): Promise<Result<Paged<LocalPoliticsCouncilSeat>, ApiError>>;
  councilCompositionFor(siruta: string): Promise<Result<LocalPoliticsCouncilSeat[], ApiError>>; // bounded ≤ ~60 rows/UAT

  // mayors
  getMayorFor(siruta: string): Promise<Result<LocalPoliticsMayor | null, ApiError>>;
  listMayors(
    f: MayorFilterInput,
    page: OffsetPage
  ): Promise<Result<Paged<LocalPoliticsMayor>, ApiError>>;

  // BEC-2024 party/vote correlation rollup (provisional)
  partyPresence(f: PartyFilterInput): Promise<Result<LocalPoliticsPartySummary[], ApiError>>;

  // kernel contributor support (UAT grain, by CUI)
  presenceForCui(
    cui: string
  ): Promise<Result<{ hasCouncil: boolean; hasMayor: boolean; siruta: string } | null, ApiError>>;
}
```

- **Schema/tables hit:** `local_politics.*` only, plus a **read join** to
  `core.territories` for territory-filter resolution (kernel `TerritoryRepo`
  does the resolve; this repo applies the resolved `siruta[]` predicate).
- **Indexes (proposed, owned by promotion-slice migration, not the server):**
  `council_seats(siruta_code)`, `council_seats(party_label)`,
  `mayors(siruta_code)`, `uats(cui)` PK, `uats(siruta_code)` unique. The dataset
  is **tiny** (≤ ~11k rows/table) → **no partitioning, no heavy-scan concern**;
  every list endpoint is a bounded indexed scan. Foreign-key to
  `core.territories` is the loader's decision; the server only reads.
- **No `flows.money_flows` access** (this source contributes no money flow).

---

## 4. Usecases

> **DEFERRED — pending serving promotion.**

| Usecase                 | Signature                                             | Notes                                                               |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| `getCouncilComposition` | `(siruta) → Result<CouncilCompositionView, ApiError>` | seats grouped by party for one UAT; **labelled provisional**        |
| `getMayor`              | `(siruta) → Result<MayorView                          | null, ApiError>`                                                    | one UAT's mayor claim; provisional |
| `listCouncilSeats`      | `(filter, page) → Result<Paged<…>, ApiError>`         | filterable across UATs (by county/region/party)                     |
| `getPartyPresence`      | `(filter) → Result<PartySummary[], ApiError>`         | BEC-2024 party presence/votes rollup; **NOT seat-allocation truth** |
| `getUatPolitics`        | `(cui) → Result<UatPoliticsView, ApiError>`           | council + mayor for one UAT (module-local; cross-source via kernel) |

**Every view model embeds the `ProvenanceStamp`** and a top-level
`caveats: string[]` defaulting to
`["provisional — sourced from Wikipedia, not canonical officeholder identity",
"BEC-2024 validates party presence/votes, not exact seat allocation"]`.
Usecases never strip it.

**Cross-source contributor (§4.4):**

```ts
const localPoliticsContributor: SourceContributor = {
  source: 'local-politics',
  async presenceFor(cui) {
    /* uats.cui == cui → { hasCouncil, hasMayor } */
  },
  async profileSlice(cui) {
    /* council composition + mayor for that UAT, provisional-stamped */
  },
};
```

- **`flow_type` registered: NONE.** This source has no money flow; it MUST NOT
  register a `flow_type` (foundation §4.3).
- **`doc_type` registered:** `local_politics_council` (per UAT council
  composition) — **search-gated, see §9**; provisional.

---

## 5. REST endpoints

> **DEFERRED — pending serving promotion.** Paths/shapes are the target
> contract. All under the public-read prefix (foundation §8.1 / §14.11
> per-route `config: { public: true }`).

| Method | Path                                          | Query/params (TypeBox)                                                      | Response                                                       | Pagination                           | Cache  | Timeout         |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ | ------ | --------------- |
| GET    | `/api/v1/local-politics/uats`                 | `UatFilter` (county, region, siruta[], q, hasCouncil, hasMayor)             | `LocalPoliticsUat[]`                                           | offset (cheap count, tiny set §14.4) | 1h TTL | 5s              |
| GET    | `/api/v1/local-politics/uats/:siruta`         | path `siruta`                                                               | `LocalPoliticsUat`                                             | —                                    | 1h TTL | 5s              |
| GET    | `/api/v1/local-politics/uats/:siruta/council` | path                                                                        | `CouncilCompositionView` (seats by party + provenance/caveats) | — (bounded ≤~60)                     | 1h TTL | 5s              |
| GET    | `/api/v1/local-politics/uats/:siruta/mayor`   | path                                                                        | `LocalPoliticsMayor`                                           | —                                    | 1h TTL | 5s              |
| GET    | `/api/v1/local-politics/council-seats`        | `CouncilFilter` (county, region, siruta[], party, becMatchStatus, minSeats) | `LocalPoliticsCouncilSeat[]`                                   | offset                               | 1h TTL | 5s              |
| GET    | `/api/v1/local-politics/mayors`               | `MayorFilter` (county, region, siruta[], party, becMatchStatus)             | `LocalPoliticsMayor[]`                                         | offset                               | 1h TTL | 5s              |
| GET    | `/api/v1/local-politics/parties/presence`     | `PartyFilter` (county, region, party)                                       | `LocalPoliticsPartySummary[]` (provisional rollup)             | offset                               | 1h TTL | 15s (aggregate) |
| GET    | `/api/v1/local-politics/filters/resolve`      | `dim` (`party`\|`uat`\|`county`\|`region`), `q`                             | resolved values                                                | —                                    | 1h TTL | 5s              |

**Envelope (foundation §5.2 / §14.11):** success `{ ok:true, data, meta }`,
error `{ ok:false, error, message, field?, requestId }`. **Every `data` payload
for this module additionally carries `data.authority = "provisional"` and
`data.caveats[]`** — the response envelope makes the non-authoritative status
machine-readable, not just prose. OpenAPI fragment marks the whole tag
**`x-authority: provisional`** and documents the caveat in every operation's
description.

---

## 6. GraphQL

> **DEFERRED — pending serving promotion.** SDL is the target; all types
> domain-prefixed `LocalPolitics*` (foundation §14.8 — no bare `Council`,
> `Mayor`, `Party`).

```graphql
# local-politics/shell/graphql/typedefs  — extends root Query
enum LocalPoliticsAuthority {
  PROVISIONAL
} # closed enum — only value
# closed enum; the raw match_status columns carry NO CHECK constraint (NOTES §"no
# CHECK on source enums") so the LOADER MUST fold any unanticipated source value to
# OTHER before projecting to serving — otherwise a future re-export value would
# hard-fail GraphQL enum serialization. Contract: unknown → OTHER (never a new bare value).
enum LocalPoliticsBecMatch {
  MATCHED
  NO_MATCH
  PARTY_NO_MATCH
  NAME_NO_MATCH
  OTHER
}

type LocalPoliticsProvenance {
  source: String! # "wikipedia"
  authority: LocalPoliticsAuthority! # always PROVISIONAL
  becValidated: String! # "party_presence_only"
  sourceRunId: String!
  pageRevisionId: String
}

type LocalPoliticsUat {
  cui: CUI!
  siruta: SIRUTA!
  name: String!
  countyName: String
  territory: Territory # resolved via kernel territory hub (§4.2) + DataLoader on siruta
  council: [LocalPoliticsCouncilSeat!]!
  mayor: LocalPoliticsMayor
  provenance: LocalPoliticsProvenance!
  caveats: [String!]!
}

type LocalPoliticsCouncilSeat {
  party: String!
  seats: Int!
  becMatchStatus: LocalPoliticsBecMatch!
  becVoteShare: String # numeric as string (§14.1)
  becVotes: BigInt
  acceptedForMap: Boolean! # always false in staging
  provenance: LocalPoliticsProvenance!
}

type LocalPoliticsMayor {
  name: String! # public elected-official name
  partyLabel: String
  becWinnerParty: String
  partyMatchStatus: LocalPoliticsBecMatch!
  nameMatchStatus: LocalPoliticsBecMatch!
  acceptedForMap: Boolean!
  provenance: LocalPoliticsProvenance!
}

type LocalPoliticsPartySummary {
  party: String!
  uatCount: Int!
  totalSeats: Int! # SUM of Wikipedia seat counts — provisional
  becVotesTotal: BigInt
  provenance: LocalPoliticsProvenance!
}

extend type Query {
  localPoliticsUat(siruta: SIRUTA!): LocalPoliticsUat
  localPoliticsCouncilSeats(
    filter: LocalPoliticsCouncilFilter
    first: Int
    after: String
  ): LocalPoliticsCouncilSeatConnection!
  localPoliticsMayors(
    filter: LocalPoliticsMayorFilter
    first: Int
    after: String
  ): LocalPoliticsMayorConnection!
  localPoliticsPartyPresence(filter: LocalPoliticsPartyFilter): [LocalPoliticsPartySummary!]!
}

# Entity join-type extension (§6.2) — UAT grain only, resolved by CUI via contributor.profileSlice
extend type Entity {
  localPolitics: LocalPoliticsUat # null for non-UAT entities / entities absent from this staging source
}
```

- **`Entity.localPolitics` resolver** calls the **same**
  `contributor.profileSlice(cui)` usecase REST uses (foundation §14.7), backed by
  a **DataLoader keyed by CUI** (§14.1). Returns `null` (never errors) when the
  CUI is not a UAT in this staging source.
- `territory` field resolves through the **kernel** territory DataLoader on
  `siruta` (§4.2) — the module does not duplicate territory data.
- Connections (`…Connection/…Edge/pageInfo`) use the kernel cursor encoder for
  REST/GraphQL parity (§5.3/§14.3).

---

## 7. Filters

> **DEFERRED — pending serving promotion** (specs are declared against proposed
> serving columns; reconcile to `local_politics.tsv` when it lands). Specs only —
> the **kernel ships the filter pipeline** (§14.2); this module declares specs
> that consume `toTypeBox` / `toGraphQLInput` / `toConditionBuilders` /
> `canonicalizeFilters`.

**Primary correlation dimension = TERRITORY** (kernel `TerritoryFilter` family,
§7.2), resolved through the territory hub. Every collection composes it.

`council_seats` collection filter spec (representative; mayors/uats analogous):

| field             | type   | ops                | driving column / index                                         | REST param ↔ GraphQL input ↔ MCP                    |
| ----------------- | ------ | ------------------ | -------------------------------------------------------------- | --------------------------------------------------- |
| `siruta`          | string | `in`               | `council_seats.siruta_code` (idx) → resolved via territory hub | repeated `siruta` ↔ `siruta:[SIRUTA!]` ↔ `siruta[]` |
| `county_code`     | string | `in`               | territory hub → resolved `siruta[]` predicate                  | `countyCode` ↔ list ↔ list                          |
| `region`          | string | `in`               | territory hub → resolved `siruta[]`                            | `region` ↔ list ↔ list                              |
| `party`           | string | `eq`,`in`,`prefix` | `council_seats.party_label` (idx)                              | `party` ↔ `party` ↔ `party`                         |
| `becMatchStatus`  | enum   | `eq`,`in`          | `council_seats.bec_match_status`                               | `becMatchStatus` ↔ enum ↔ enum                      |
| `minSeats`        | int    | `gte`              | `council_seats.seats`                                          | `minSeats` ↔ `{from}` ↔ `minSeats`                  |
| `hasCouncilTable` | bool   | `eq`,`isNull`      | `uats.has_council_table` (for `uats`)                          | `hasCouncil` ↔ bool ↔ bool                          |
| sort              | —      | —                  | default `seats desc`; allowed `seats`,`party`,`siruta`         | —                                                   |

- **Text engine for `q`:** **Postgres trigram / Meili autocomplete** for
  UAT-name and party-label resolution (`/filters/resolve`). There is **no
  full-text body** in this source (it's structured seat/party data) → **no
  OpenSearch relevance dependency**; semantic search is **n/a** (§9).
- `isNull` (foundation §14.2 mandatory) backs **coverage questions** ("which
  UATs have no council table?" → `hasCouncilTable isNull`/`eq:false`; "which
  council rows have `bec_match_status = no_match`?").
- **Discovery / resolve dimensions (§7.4):** `party` (label → canonical label),
  `uat` (name → SIRUTA via territory hub), `county`, `region`. The
  `missing_entities`/`party_label_review` raw tables are **not** exposed as
  public resolve dimensions (data-quality internals).

**Golden question → filter examples** (the catalog
`AI_AGENT_FILTER_QUESTION_CATALOG.md` has **no dedicated local-politics
questions** — this module is net-new surface; these are the proposed golden
cases, every answer **stamped provisional**):

| Q                                                  | Filter                                             | Authoritative source                                  |
| -------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| "Council composition of Cluj-Napoca?"              | `uats/:siruta/council` (siruta resolved from name) | **provisional** (Wikipedia seats)                     |
| "Which parties hold council seats in Cluj county?" | `council-seats?countyCode=…&sort=seats`            | provisional                                           |
| "Mayor of UAT X and their party?"                  | `uats/:siruta/mayor`                               | provisional (BEC name-match flagged)                  |
| "UATs where BEC party-match failed?"               | `council-seats?becMatchStatus=no_match`            | staging signal (data-quality)                         |
| "Party presence nationally (BEC-2024 votes)?"      | `parties/presence`                                 | **provisional** — presence/votes only, NOT seat truth |

---

## 8. MCP tools

> **DEFERRED — pending serving promotion.** Tool shapes are the target;
> input/output TypeBox, handler → core usecase (foundation §6.3).

Two families (§6.3):

1. **Discovery:** `resolve_local_politics_filters` — wraps
   `/filters/resolve` (party/uat/county/region → values). Shared kernel
   infra parameterized for this source.
2. **Query:**
   - `get_local_politics_uat` — input `{ siruta? , uatName? }`; output
     `{ ok, kind:'local_politics_uat', item:{ council, mayor, provenance, caveats }, link, summary }`.
   - `rank_local_politics_party_presence` — input `{ county?, region?, party? }`;
     output provisional party-presence rollup.

**Output contract (every tool):** the structured object **MUST** carry
`item.authority = "provisional"` and a `caveats[]` array, and the `summary`
sentence MUST be phrased as a Wikipedia-sourced provisional claim
(e.g. _"Per Wikipedia (provisional, not BEC-validated seat allocation), the
local council of <UAT> has …"_). Tools **never** present seats as fact.
`link` deep-link: `<client>/local-politics/uat/<siruta>`. Rate-limited; bounded
result sizes; **no PII** (no member names; review tables excluded).

---

## 9. Search integration

> **DEFERRED — pending serving promotion.** And **capability-gated** (§14.5).

- **`doc_type` owned:** `local_politics_council` (one doc per UAT council
  composition: `title` = UAT name, `body` = party-seat summary text, `cuis` =
  `[uat_cui]`, `county_name`, `url` = client deep link, `attrs.authority =
"provisional"`). **The scrapper `search` lane writes these; the server only
  reads** (foundation §4.5).
- **Meilisearch:** entity-name / UAT autocomplete (instant). **Primary search
  value of this source.**
- **OpenSearch:** optional relevance over the small council-composition corpus;
  **low priority** (structured data, no long-form text). Degrade gracefully if
  OS is down (§14.5).
- **Semantic/pgvector:** **n/a** — no long-form text to embed; this source does
  **not** request a vector column. Treat semantic as unavailable (return `null` +
  caveat if ever queried).
- **Whether this source projects into `search.documents` at all is an open
  question (§13)** — it may be sufficient to rely on the kernel UAT/territory
  search and skip a dedicated `doc_type`. Decide at promotion time.

---

## 10. Sync / freshness impact on serving

> **DEFERRED — pending serving promotion.**

- **Cadence:** **none / manual re-export.** This slice **owns no live crawler**
  (NOTES "Gotchas"). Refresh = re-export from the sandbox corpus → re-run BEC
  correlation → new run id → re-import into raw → re-run promotion loader. The
  frozen `20260518` dataset digest is a **tripwire**: a new export deliberately
  fails the raw `validate` gate until the EXPECTED constants are regenerated.
- **Cache TTL:** **long (1h+, or effectively static)** — the data changes only
  on a deliberate re-export, not on a request path or daily loader. No per-request
  invalidation needed.
- **"As-of" semantics:** the API surfaces `provenance.sourceRunId` (`20260518`)
  and `pageRevisionId` as the **freshness watermark** on every read (foundation
  §14.11 loader-completion version stamp). The serving read also reports the
  promotion-loader run id as the domain watermark. **No "live"/"current"
  language** — the API states the Wikipedia snapshot date, not "as of today".

---

## 11. Wiring

> **DEFERRED — pending serving promotion.**

```ts
// local-politics/index.ts
export function makeLocalPoliticsModule(deps: {
  db: Kysely<ProdDatabase>; // typed over transparenta_prod incl. local_politics.*
  territoryRepo: TerritoryRepo; // kernel §4.2
  identityRepo: IdentityRepo; // kernel §4.1 (CUI link at UAT grain)
  search?: SearchClient; // capability-gated §14.5
  cache: Cache;
}): LocalPoliticsModule {
  /* { restPlugin, graphql, mcpTools, contributor, repos } */
}
```

- **`build-app.ts`:** register REST plugin under `/api/v1/local-politics`, merge
  GraphQL slice, register MCP tools, **register `localPoliticsContributor` into
  the kernel registry** (§4.4) so it joins UAT-360 / global search without
  editing the kernel.
- **Env additions:** none beyond kernel-owned (`PROD_DATABASE_URL`, Meili). The
  module is **feature-flag-gated OFF by default** until promotion (a
  `MODULES_ENABLED` exclusion) so it cannot be accidentally mounted against a
  missing schema.
- **Legacy module superseded:** **none.** This is net-new surface (the legacy
  `unified` module never exposed local-politics).

---

## 12. Testing

> **DEFERRED — pending serving promotion** (integration needs the serving
> schema). Unit-level filter/cursor tests can be written ahead of the schema.

- **Unit (`tests/unit/local-politics/`):** filter spec → SQL compilation snapshot
  (territory/party/becMatchStatus); cursor encode/decode; **provenance-stamp
  invariant test** (asserts every view model carries `authority:'provisional'`
  and non-empty `caveats[]` — the contract guard); `acceptedForMap` is always
  `false` in any projection.
- **Integration (`tests/integration/local-politics/`):** REST + GraphQL + MCP
  against a seeded `local_politics` fixture; **tri-surface equivalence** for the
  same `canonicalizeFilters` input (§14.2); **authority-label leak test** —
  assert **no** surface can emit a record without the `provisional` stamp, and no
  surface presents seats as BEC-validated.
- **Golden filters:** the proposed §7 golden cases as integration assertions,
  each verifying the provisional caveat is present in the response.

---

## 13. Open questions / risks

1. **Serving promotion is the blocker (§0).** Nothing here is buildable until a
   scrapper slice creates `local_politics` in `transparenta_prod` and loads it
   through a two-tier gate. **User/architecture decision required:** is
   promoting a _non-authoritative staging_ source to serving desired at all, or
   should it stay raw-only indefinitely? (It may be more honest to expose it
   **only** as a flagged, clearly-provisional client overlay rather than a
   first-class API domain.)
2. **Authority labelling must be structural, not cosmetic.** Risk: a future
   consumer treats Wikipedia seat counts as official. Mitigation: `authority`
   constant enum (`PROVISIONAL` only), mandatory `caveats[]`, `acceptedForMap`
   always-false invariant test, `x-authority: provisional` on the whole OpenAPI
   tag. **This is the dominant risk and the reason the plan is gated.**
3. **CUI grain confusion.** The only CUI is the **UAT's**; council members and
   mayors are persons with no CUI. Risk: a contributor or `Entity` extension
   mis-attributes person data to an org. Mitigation: contributor + `Entity.
localPolitics` are **UAT-grain only**, documented in §2/§6.
4. **BEC ≠ seat allocation.** `bec_*_correlation` validates **party presence and
   votes**, not exact seats. The `party_presence` rollup must never be presented
   as a seat-allocation source of truth (`becValidated: "party_presence_only"`).
5. **Territory linkage quality.** Promotion depends on canonicalizing
   `resolved_siruta` → `core.territories.territorial_siruta_code`. Risk: a
   resolved SIRUTA absent from the territory hub (the 1 Bucharest/BEC gap, and
   the 28 CUI-map-derived SIRUTAs). Mitigation: loader validates SIRUTA against
   the hub, warns-and-records misses (two-tier gate); the API degrades the
   `territory` field to `null` + caveat rather than erroring.
6. **`search.documents` projection is optional (§9).** Decide at promotion
   whether a dedicated `local_politics_council` `doc_type` adds value over kernel
   UAT/territory search.
7. **Privacy posture for mayor names.** Treated here as public elected-official
   data (servable, provisional-stamped). Confirm this matches the platform
   privacy stance (foundation §8.2) at promotion — if it must be gated like
   judicial names, the mayor surface degrades to party-only.
8. **Catalog gap.** `AI_AGENT_FILTER_QUESTION_CATALOG.md` defines **no**
   local-politics questions — the §7 golden cases are net-new and should be
   ratified (and ideally added to the catalog) before this module is treated as
   a requirements-complete surface.

---

### Adversarial review log

This plan was self-reviewed against the foundation contract and a general-purpose
reviewer subagent audited it for **(a)** overstated data availability/authority
and **(b)** contract conformance (provenance labelling, territory linkage,
namespacing, no-flow/no-CUI-person divergences). Findings incorporated;
the §0 prerequisite and the structural authority-labelling invariants (§2/§5/§13)
are the result of that pass.
