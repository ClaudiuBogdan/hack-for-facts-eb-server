# 04 — Parliament module plan

> **Status:** plan. Conforms to `00-foundation-shared-kernel.md` (binding).
> Schema source of truth: `_prod-schema/parliament.tsv` + scrapper migrations
> `20260612T170000__parliament_domain.ts`, `…170100__parliament_links.ts`,
> `…210000__parliament_persons_cluster_key.ts`,
> `…213000__parliament_candidates_fk_set_null.ts`,
> `…20260615T120000__parliament_search_doc_types.ts`; verified against the live
> `transparenta_prod` `parliament` schema + `pg_indexes` (2026-06-16).
> Supersedes the unified-explorer parliament surface
> (`src/modules/unified/{shell/repo/parliament-source-repo.ts,
shell/rest/sources/routes-parliament.ts, core/parliament-mapping.ts}`).

GraphQL type prefix: **`Parliament*`** (§14.8). REST prefix:
**`/api/v1/parliament/`**. The module is read-only (§F5).

---

## 1. Summary & data status

Parliament is the **legislative-process spine**: bills move through chambers,
get voted member-by-member, and become laws published in Monitorul Oficial —
which links this source to the `legal` module. The marquee queries are lineage
questions ("who voted for _Legea 423/2023_", "what did this bill become") and
member-accountability questions ("how does deputy X vote", "which parties are
cohesive").

**In prod now** (loaded + gate-green 2026-06-12/13, full backfill;
`PARLIAMENT_NOTES.md` load evidence):

| Table                                   | Rows                | Notes                                                                                                                 |
| --------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `parliament.members`                    | 5,289               | one row per mandate; `mandate_key` PK; 10 legislatures 1990–2024                                                      |
| `parliament.parliamentary_groups`       | 73                  | `group_id = slug(name)-<chamber>`                                                                                     |
| `parliament.group_membership_intervals` | derived             | gaps-and-islands over per-vote labels; vote-date granularity                                                          |
| `parliament.persons`                    | 2,988               | clustered identity; 1,200 multi-mandate careers; never a hard merge                                                   |
| `parliament.person_identity_candidates` | ~2,220 review queue | needs_review / ambiguous / rejected kept as data                                                                      |
| `parliament.bills`                      | 9,050               | 7,391 CDEP + ~1,659 senate stubs                                                                                      |
| `parliament.bill_events`                | 113,116             | per-bill timeline; `vote_idv` 3,773                                                                                   |
| `parliament.bill_documents`             | 93,774              |                                                                                                                       |
| `parliament.votes`                      | 20,586              | CDEP 2016+, Senate 2005+, joint 2018+                                                                                 |
| **`parliament.vote_records`**           | **4,133,356**       | **the heavy table — one ballot per member-vote**                                                                      |
| `parliament.control_items`              | 81,513              | questions/interpellations/motions, 1997+                                                                              |
| `parliament.member_initiatives`         | 172,061             | initiative→bill (106,779 resolved)                                                                                    |
| `parliament.speeches`                   | 1,405,905           | CDEP 1996+, Senate 2001+; `quarantined` flag                                                                          |
| `parliament.bill_act_links`             | 9,050               | multi-row per bill by `relationship_kind` (currently ≈1 `becomes_law`/bill); 3,066 LINKED to real `legal.acts.act_id` |
| `parliament.bill_vote_links`            | 8,987               | roles: 4,859 final_adoption, 1,850 final_rejection, 1,498 unknown                                                     |
| `parliament.member_declarations`        | 1,670               | avere/interese, **metadata only** (link_only)                                                                         |

**Deferred (declared, not built here):** declaration _content_ extraction +
person→company(CUI) edges (policy-gated; v1 surfaces metadata only);
party→CUI org-identity link (no consumer yet); pgvector/semantic parliament
search (lexical-only v1 — `PARLIAMENT_NOTES.md` fork #8); a normalized
committee graph (committee stays a text dimension on `bill_events`).

**Prod schema(s) touched:** `parliament.*` (own); `legal.acts` /
`legal.act_citation_keys` (read-only, via the kernel cross-module link, §6.7);
`search.documents` (read-only, four owned `doc_type`s); kernel `core.*`
(identity hub — parliament has **no CUI on members**, see §2.5).

---

## 2. Schema → domain model

Module `core/types.ts` view models (camelCase; scalars per §14.1). Row types in
`shell/repo` mirror live columns; mappers convert to view models. **Dates are
emitted `::text` (`YYYY-MM-DD`)** — pg returns `Date` objects otherwise (the
unified repo's `vote_date::text` precedent). `bigint` identity columns
(`person_id`, `declaration_id`, `bill_act_link_id`, `bill_vote_link_id`,
`candidate_id`) are **strings** end to end (§14.1; pg int8 parser → string).

### 2.1 Member (mandate) — `parliament.members`

```ts
export interface ParliamentMember {
  readonly mandateKey: string; // members.mandate_key (PK; THE attribution key)
  readonly chamber: string | null; // 'camera_deputatilor' | 'senat' (DB value)
  readonly legislature: string | null; // election year, e.g. '2024'
  readonly fullName: string | null;
  readonly normalizedName: string | null;
  readonly groupName: string | null; // display label at mandate scope
  readonly groupId: string | null; // FK parliamentary_groups.group_id
  readonly constituencyName: string | null;
  readonly birthDate: string | null; // birth_date::text; PII-light — see §2.6
  readonly personId: string | null; // FK persons.person_id (bigint→string)
  readonly attrs: Record<string, unknown>; // last_event_date / source_title / procedure / profile_url
}
```

`mandate_key` stays the attribution key on votes/initiatives/control/speeches.
`person_id` is the derived cross-mandate bridge. `birth_date_text` /
`birth_date_parse_method` are **provenance, not surfaced** (see §2.6).

### 2.2 Group + interval — `parliamentary_groups`, `group_membership_intervals`

```ts
export interface ParliamentGroup {
  readonly groupId: string; // slug(name)-<chamber>
  readonly chamber: string;
  readonly name: string;
  readonly memberCount?: number; // computed per legislature (not stored)
}
export interface ParliamentGroupInterval {
  readonly mandateKey: string;
  readonly groupId: string;
  readonly validFrom: string; // date::text — vote-date granularity
  readonly validTo: string | null; // null = current
  readonly source: string; // 'derived_from_votes'
  readonly voteCount: number | null;
}
```

The interval table is the **switcher-aware** group history (a mid-mandate party
change shows as two intervals); the `members.group_name` snapshot is the
single display label. Surfacing both is an improvement over the old surface,
which only knew the snapshot.

### 2.3 Bill + timeline — `bills`, `bill_events`, `bill_documents`

```ts
export interface ParliamentBill {
  readonly billKey: string;
  readonly plxNumber: string | null;
  readonly plxYear: number | null;
  readonly senateNumber: string | null;
  readonly senateYear: number | null;
  readonly title: string | null;
  readonly finalLawNumber: string | null;
  readonly finalLawYear: number | null;
  readonly attrs: Record<string, unknown>; // status_text / last_event_date / procedure / source_title
  readonly sourceUpdatedAt: string | null; // timestamptz ISO
  readonly updatedAt: string | null;
}
export interface ParliamentBillEvent {
  readonly position: number;
  readonly eventDate: string | null;
  readonly eventDateText: string | null;
  readonly description: string | null;
  readonly chamberCode: string | null;
  readonly committee: string | null;
  readonly voteIdv: string | null; // explicit timeline→vote evidence
  readonly docs: readonly unknown[];
}
export interface ParliamentBillDocument {
  readonly url: string;
  readonly label: string | null;
  readonly kind: string | null;
  readonly position: number | null;
}
```

### 2.4 Vote + record — `votes`, `vote_records`

```ts
export interface ParliamentVote {
  readonly voteKey: string; // 'cdep:<votid>' | 'senat:<app_id>'
  readonly chamber: string;
  readonly voteDate: string | null; // vote_date::text
  readonly title: string | null;
  readonly tally: {
    pentru: number | null;
    impotriva: number | null;
    abtinere: number | null;
    nuAVotat: number | null;
    present: number | null;
  };
  readonly outcome: string | null; // 'adoptat' | 'respins' | null
  readonly divisionNumber: number | null;
  readonly billKey: string | null;
  readonly lawReference: string | null; // Senate L-ref, title-extracted
  readonly attrs: Record<string, unknown>; // source_title / tally_mismatch / vote_action
}
export interface ParliamentVoteRecord {
  readonly rowIndex: number;
  readonly memberName: string | null; // raw source name (audit)
  readonly groupName: string | null; // raw group AT vote
  readonly choice: string | null; // 'pentru'|'impotriva'|'abtinere'|'nu_a_votat'
  readonly rawMarker: string | null; // chamber-native marker
  readonly mandateKey: string | null; // nullable BY DESIGN (collisions never auto-resolved)
  readonly matchMethod: string | null;
}
```

`vote.outcome` is a **vote-level** result (`pentru>impotriva`), **not** the
bill outcome — a vote _adopting a rejection report_ has `outcome='adoptat'` but
the bill is rejected. Bill outcome lives in `bill_vote_links.role`
(`final_adoption` vs `final_rejection`). The view model never conflates them.

### 2.5 Member activity — `control_items`, `member_initiatives`, `speeches`

```ts
export interface ParliamentControlItem {
  readonly itemKey: string;
  readonly controlType: string | null; // question|interpellation|motion|unknown
  readonly controlTypeProvenance: string | null; // split_pass|combined_pass
  readonly title: string | null;
  readonly recipient: string | null;
  readonly itemDate: string | null;
  readonly responseStatus: string | null;
  readonly authorName: string | null;
  readonly mandateKey: string | null;
}
export interface ParliamentInitiative {
  readonly initiativeKey: string;
  readonly mandateKey: string;
  readonly billKey: string | null;
  readonly title: string | null;
  readonly status: string | null;
  readonly promulgatedLawNumber: string | null;
  readonly promulgatedLawYear: number | null;
}
export interface ParliamentSpeech {
  readonly speechKey: string;
  readonly mandateKey: string | null;
  readonly speakerName: string | null;
  readonly chamber: string | null;
  readonly spokenAt: string | null;
  readonly title: string | null;
  readonly summary: string | null; // quarantined rows EXCLUDED by default (§2.6)
}
```

### 2.6 Identity / territory linkage; PII & excluded columns

- **No CUI on members.** Parliament does not link to the `core.organizations`
  identity hub at the _person_ grain (people aren't orgs; party→CUI is deferred).
  The kernel `Entity` join (§6.6) is therefore **not** wired from a member CUI;
  parliament contributes to `Entity` only via the **`recipient`** dimension of
  control items (a minister/ministry an interpellation is addressed to) — and
  only once recipient→CUI canonicalization exists (deferred; the field is
  surfaced as a string filter today).
- **No SIRUTA.** `constituency_name` is a Romanian county/diaspora label, not a
  SIRUTA code; it stays a free-text filter resolved by slug (not via the
  territory hub). Stated as a deliberate non-use of the kernel territory family.
- **Privacy / excluded from default projections:**
  - `members.birth_date_text`, `birth_date_parse_method`, `persons.birth_date_text`
    — provenance; not surfaced. `birth_date` (the parsed date) IS surfaced
    (public-figure DOB, already on the public CDEP profile pages).
  - `member_declarations.file_hash` — internal dedup; not surfaced. **Declaration
    _content_ is never read** (v1 `content_status='link_only'`); only
    `{type, date, label, file_url}` metadata is exposed.
  - `speeches` with `quarantined=true` (joint-sitting empty shells) are
    **excluded from every default projection** (a `WHERE quarantined=false`
    predicate in the repo; an explicit `includeQuarantined` flag is _not_ offered
    in v1).
  - `*_identity_candidates` rows with `status IN ('needs_review','rejected','ambiguous')`
    are internal correlation state — exposed only through a dedicated
    low-traffic "data quality" endpoint (§5 #19), never mixed into member/person
    reads. That endpoint is **API-key gated** (the §8.1 `x-api-key` mechanism,
    not `public:true` like the data routes) **and** its `CandidateView`
    **excludes the internal `evidence` jsonb and `method`** matcher state — it
    projects only `{ mandateKey, personId, status }`. The §12 privacy test
    covers this projection.
  - `persons.cluster_key` (the internal clustering anchor) is **never surfaced**;
    `person_id` is the only person key clients see.

---

## 3. Repo interface (ports)

`shell/repo/parliament-repo.ts` over the typed `ProdDatabase` Kysely instance.
Every method returns `Result<T, ApiError>` (neverthrow). Tables are
schema-qualified Kysely keys (`'parliament.votes'`). **Heavy-query rule
(§3 contract): no method scans `vote_records` unparented** — every
`vote_records` read is bounded by `vote_key` (PK prefix) or `mandate_key`
(secondary index). The driving index is named per method.

```ts
export interface ParliamentRepo {
  // ── members / groups / persons ─────────────────────────────────────────
  latestLegislature(): Promise<Result<string | null, ApiError>>; // max(legislature)
  listMembers(q: MembersQuery): Promise<Result<Page<MemberRow>, ApiError>>; // members; offset+total (bounded by legislature)
  findMember(mandateKey: string): Promise<Result<MemberRow | null, ApiError>>; // members_pkey
  listGroupCounts(
    legislature: string,
    chamber?: string
  ): Promise<Result<GroupCountRow[], ApiError>>; // members (group_by)
  listConstituencies(legislature: string): Promise<Result<string[], ApiError>>;
  findPerson(personId: string): Promise<Result<PersonRow | null, ApiError>>; // persons_pkey
  listPersonMandates(personId: string): Promise<Result<MemberRow[], ApiError>>; // members_person_idx
  listGroupIntervals(mandateKey: string): Promise<Result<GroupIntervalRow[], ApiError>>; // pk prefix
  searchPersonsByName(qNorm: string, limit: number): Promise<Result<PersonRow[], ApiError>>; // persons_normalized_name_idx

  // ── bills / timeline ───────────────────────────────────────────────────
  listBills(q: BillsQuery): Promise<Result<Page<BillRow>, ApiError>>; // bills; offset+total
  findBill(billKey: string): Promise<Result<BillRow | null, ApiError>>; // bills_pkey
  getBillEvents(billKey: string): Promise<Result<BillEventRow[], ApiError>>; // bill_events_pkey prefix
  getBillDocuments(billKey: string): Promise<Result<BillDocumentRow[], ApiError>>; // bill_documents_pkey prefix
  getBillInitiators(billKey: string): Promise<Result<InitiatorRow[], ApiError>>; // member_initiatives_bill_idx ⋈ members
  getBillActLinks(billKey: string): Promise<Result<BillActLinkRow[], ApiError>>; // bill_act_links_current_uq prefix
  getBillVoteLinks(billKey: string): Promise<Result<BillVoteLinkRow[], ApiError>>; // bill_vote_links_bill_idx

  // ── votes / records ────────────────────────────────────────────────────
  listVotes(q: VotesQuery): Promise<Result<CursorPage<VoteRow>, ApiError>>; // votes_chamber_date_idx (cursor)
  findVote(voteKey: string): Promise<Result<VoteRow | null, ApiError>>; // votes_pkey
  listVotesForBill(billKey: string): Promise<Result<VoteRow[], ApiError>>; // votes_bill_idx
  listVoteRecords(
    voteKey: string,
    q: RecordsQuery
  ): Promise<Result<CursorPage<VoteRecordRow>, ApiError>>; // vote_records_pkey (vote_key, row_index)
  voteGroupBreakdown(voteKey: string): Promise<Result<GroupBreakdownRow[], ApiError>>; // vote_records_pkey prefix, group_by

  // ── member activity (always parented by mandate_key or person_id) ───────
  listMemberVotes(
    mandateKey: string,
    q: CursorQuery,
    filter?: FilterInput
  ): Promise<Result<CursorPage<MemberVoteRow>, ApiError>>; // vote_records_mandate_idx ⋈ votes; materialize+sort (§3.1.1), not an index seek; filter (memberVotesFilterSpec: voteDate/chamber/outcome/choice) ANDed onto the mandate bound → total is the exact FILTERED count
  memberVoteActivity(
    mandateKey: string,
    year: number,
    filter: FilterInput
  ): Promise<Result<MemberVoteActivity, ApiError>>; // per-day heatmap: 2 aggregates over the SAME filter — per-day counts (year-bounded) + distinct availableYears (not year-bounded)
  listMemberControlItems(
    mandateKey: string,
    q: PageQuery
  ): Promise<Result<Page<ControlItemRow>, ApiError>>; // control_items_mandate_idx
  listMemberSpeeches(mandateKey: string, q: PageQuery): Promise<Result<Page<SpeechRow>, ApiError>>; // speeches_mandate_idx
  listMemberInitiatives(
    mandateKey: string,
    q: PageQuery
  ): Promise<Result<Page<InitiativeRow>, ApiError>>; // member_initiatives_mandate_idx
  listMemberDeclarations(mandateKey: string): Promise<Result<DeclarationRow[], ApiError>>; // member_declarations_uq prefix

  // ── control items list (standalone) ─────────────────────────────────────
  listControlItems(q: ControlQuery): Promise<Result<CursorPage<ControlItemRow>, ApiError>>; // see §3.2

  // ── lineage (the marquee path) ──────────────────────────────────────────
  votesForActId(actId: string, opts: LineageOpts): Promise<Result<LineageVoteRow[], ApiError>>; // bill_act_links_target_idx → bill_vote_links_bill_idx → votes
  ballotsForVote(voteKey: string, opts: BallotOpts): Promise<Result<LineageBallotRow[], ApiError>>; // vote_records_pkey ⋈ members ⋈ persons

  // ── data-quality / correlation surface ──────────────────────────────────
  listPersonCandidates(q: CandidateQuery): Promise<Result<Page<CandidateRow>, ApiError>>; // person_candidates_status_idx

  // ── contributor (kernel registry, §4) ────────────────────────────────────
  controlPresenceForRecipient(
    cui: string
  ): Promise<Result<{ count: number; lastDate: string | null } | null, ApiError>>; // deferred until recipient→CUI
}
```

### 3.1 The `vote_records` strategy (4.13M rows — the central design point)

Live indexes (verified): PK `(vote_key, row_index)`; secondary
`vote_records_mandate_idx (mandate_key)`. **There is no temporal, choice, or
group index on `vote_records`, and no date column on the row.** Consequences,
binding for every endpoint:

1. **`vote_records` is never the driving table of a flat list.** It is read
   only through a parent key:
   - **By vote** (`listVoteRecords`, `voteGroupBreakdown`): bounded by
     `vote_key` (PK prefix) — a single vote has at most one assembly's ballots
     (~470 CDEP / ~580 joint `comun`; low hundreds), so this is a tiny,
     index-only range scan. Cursor pagination on `row_index` (the PK tail);
     offset+total is also cheap here, but we use **cursor** for tri-surface
     uniformity with the heavy paths.
   - **By member** (`listMemberVotes`): driven by `vote_records_mandate_idx`
     `(mandate_key)` — one member ≈ 4.13M / 5,289 ≈ 780 ballots avg, fully
     bounded. **The mandate index carries only `mandate_key`** (no `vote_key`,
     `row_index`, or `vote_date`), so this is **not** a seekable index-ordered
     cursor over `(vote_date,…)`. The repo **materializes the member's full
     ballot set** (≤ low thousands), `INNER JOIN votes` for date/title/outcome,
     sorts in memory by `vote_date DESC, vote_key DESC, row_index`, and slices —
     the cursor is a position into that stable in-memory order, not an index
     seek. This is correct precisely because the per-member set is small and
     bounded; it would be wrong for any unparented scan. The cursor tuple
     `(vote_date, vote_key, row_index)` is the stable sort key, encoded with
     `fhash` (§14.3); it is **not** claimed to be index-backed. **An optional
     `filter` (memberVotesFilterSpec: voteDate/chamber/outcome/choice) compiles
     to WHERE conditions ANDed onto the `mandate_key` bound** — the materialize +
     in-memory sort + `findIndex` cursor logic is unchanged; only the WHERE now
     carries the spec-compiled conditions, so `total` is the exact count over the
     FILTERED slice. The cursor `fhash` is now derived from the mandate **and the
     filter** (`memberVotesFhash(mandateKey, filter)`), so a cursor is rejected if
     replayed under a different filter. This is a one-time cursor-format break:
     the empty-filter `fhash` changed from `memberVotes:<mandate>` to the
     canonicalized form, so any in-flight member-votes cursor from a session open
     across the deploy is rejected once with `INVALID_INPUT` and the client
     re-fetches from page 1 (accepted; cursors are ephemeral).
   - **Per-day activity** (`memberVoteActivity`): the heatmap runs two aggregates
     over the SAME filter conditions — a per-day `GROUP BY vote_date` with
     `count(*)` + a `FILTER (WHERE choice=…)` per choice, bounded to the requested
     year; and a `DISTINCT extract(year …)` for `availableYears` (NOT year-bounded,
     so the client can offer a year switcher). `voteDate` is rejected at the
     usecase (the year argument is the range bound).
2. **No global `GET /votes/records` endpoint.** Ballot lists exist only under a
   vote or a member. A request for "all `pentru` ballots in 2024" is answered as
   a vote-scoped or aggregate query, never a 4M-row scan.
3. **Counts on the heavy path.** The vote-scoped ballot list uses the official
   tally as the authoritative count, not `COUNT(*)`. `listMemberVotes` returns
   an **exact** `{ total }` (labelled `exact`, not estimated) — it is a bounded
   `COUNT(*)` over the member's slice of the mandate index (≤ low thousands), so
   §14.4's estimated-flag does not apply here; the count is genuinely cheap.
4. **Cohesion / breakdown is per-vote aggregate** (`voteGroupBreakdown`):
   `GROUP BY group_name, choice` within one `vote_key` — index-only on the PK
   prefix, low-hundreds of rows scanned. Party cohesion across many votes (PR-3)
   is computed **per requested bill or per bounded vote set**, never as an
   unbounded cross-vote scan: the aggregate endpoint resolves the `vote_key`s
   first (by `bill_key`, or by date window+chamber off the indexed `votes`
   range) and **hard-caps the set at 500 votes** (≈235k ballots ceiling;
   declared in §5 #20 and the §7 spec, returns `InvalidInput` if the bounded
   `votes` range exceeds the cap) before fanning into `vote_records` by those
   `vote_key`s.

`statement_timeout`: 5s for vote-scoped reads, 15s for `listMemberVotes` and
cohesion aggregates.

### 3.2 Other heavy-table notes

- **`votes`** (20.6k): driving index `votes_chamber_date_idx (chamber,
vote_date DESC)` for the list; `votes_bill_idx` for bill-scoped; cursor on
  `(vote_date, vote_key)`. `q` text search hits `title`/`attrs->>'source_title'`
  via trigram/ILIKE (no FTS index — search service owns relevance), so a `q`
  query is **bounded by also requiring chamber and/or a date window** when no
  Meili/OS engine is available (the repo declares `q`-only as Meili-backed; ILIKE
  fallback requires a bounding predicate). This co-predicate rule is enforced at
  the **handler boundary** (a guard that rejects `q`-only-without-bound with
  `InvalidInput` when the search engine is down), because the kernel filter
  deriver expresses per-field ops, not cross-field requirements — see §7.
- **`speeches`** (1.41M) / **`control_items`** (81.5k) / **`member_initiatives`**
  (172k): only ever read parented by `mandate_key` (their respective mandate
  indexes) for member-activity, or — for the standalone control-items list —
  bounded by `item_date` window + `control_type` (no dedicated date index exists;
  the standalone `listControlItems` is **cursor-paginated and requires a date
  window or recipient/author bound**, declared in the spec, to stay off a full
  scan; an `(item_date)` index is flagged as an _earned-if-measured_ follow-up,
  not added speculatively per the "no speculative index" rule).
- **Lineage** (`votesForActId`): `bill_act_links_target_idx (target_act_id)` →
  `bill_vote_links_bill_idx (bill_key)` filtered to
  `role IN ('final_adoption','final_rejection')` + `resolution_status='linked'` →
  `votes_pkey`. All small, fully indexed. `ballotsForVote` then reads vote_records
  by `vote_key` ⋈ `members` ⋈ `persons`.
- **Small tables are honestly small (no index theatre).** `members` (5,289),
  `bills` (9,050), `parliamentary_groups` (73), `persons` (2,988),
  `bill_act_links`/`bill_vote_links` (~9k) have **no btree on the filter
  columns** (`members.group_name/group_id/constituency_name/legislature`,
  `bills.final_law_*`, `bill_act_links.resolution_status`). Their list/filter
  predicates are therefore **post-scan filters over a few-thousand-row table** —
  cheap by row count, not by index. The plan states this plainly rather than
  naming a non-existent driving index: these are _earned-if-measured_ index
  candidates, deliberately not pre-built (the "no speculative index" rule).
  `bills.hasLaw`/`actId` joins `bills` to `bill_act_links` (both ~9k) — a small
  hash/semi-join, not index-driven. The index-discipline rule (§3 contract)
  binds the genuinely large tables (`vote_records`, `votes`, `speeches`,
  `control_items`); the small dimension tables are exempt by size, stated here.

---

## 4. Usecases

`core/usecases/` — framework-free, over the port, returning `Result`.

| Usecase                 | Signature (→ `Result<…, ApiError>`)                | Notes                                                                                                        |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `listMembers`           | `(input: MembersFilter) → Page<MemberView>`        | default legislature = latest                                                                                 |
| `getMember`             | `(mandateKey) → MemberDetailView`                  | mandate + person + group intervals + activity counts                                                         |
| `getPerson`             | `(personId) → PersonCareerView`                    | cross-mandate: all mandates, chambers, group history, career totals                                          |
| `listGroups`            | `(legislature, chamber?) → GroupView[]`            | counts aggregated; Neafiliaţi bucket                                                                         |
| `listBills`             | `(input: BillsFilter) → Page<BillView>`            | default sort `updated_desc`                                                                                  |
| `getBill`               | `(billKey) → BillDossierView`                      | events + documents + initiators + related votes + **act links + vote links** (improvement: lineage attached) |
| `listVotes`             | `(input: VotesFilter) → CursorPage<VoteView>`      | cursor; default `vote_date DESC`                                                                             |
| `getVote`               | `(voteKey) → VoteDetailView`                       | tally + group breakdown + ballots (paged)                                                                    |
| `getVoteBallots`        | `(voteKey, cursor) → CursorPage<BallotView>`       | ballot-level, parented                                                                                       |
| `getMemberActivity`     | `(mandateKey, kind, page) → Page<…>`               | votes/control/speeches/initiatives/declarations                                                              |
| `listControlItems`      | `(input: ControlFilter) → CursorPage<ControlView>` | bounded (date window/recipient)                                                                              |
| `getLineageForAct`      | `(actId, opts) → ActLineageView`                   | **marquee**: act→bills→final votes→ballots→persons + temporal-coverage caveats                               |
| `resolveFilters`        | `(dim, q) → ResolveResult`                         | name→value (§7.4)                                                                                            |
| `dataQualityCandidates` | `(input) → Page<CandidateView>`                    | person-identity review queue                                                                                 |

**Cross-source contributor (§4.4/§14.7).** Parliament registers a
`SourceContributor` with `source:'parliament'`:

- `presenceFor(cui)`: returns presence **only** when recipient→CUI
  canonicalization is live (count of control items addressed to that org). Until
  then it returns `ok(null)` — entity-360 simply shows no parliament slice for a
  CUI, never an error. (Documented deferral; the contributor is wired so turning
  it on later needs no kernel edit.)
- `profileSlice(cui)`: same gate; returns a small "controls addressed to this
  institution" slice when available.

**Registered enums:**

- `flow_type`: **none.** Parliament has no money flow — it does not write to
  `flows.money_flows` and registers no `flow_type` (explicit, so the kernel
  `FLOW_TYPES` enum stays accurate).
- `doc_type` (search, §9): `parliament_bill_dossier`, `parliament_bill_law_link`,
  `parliament_control_item`, `parliament_speech_segment` (per the
  `…search_doc_types` migration).

---

## 5. REST endpoints

Prefix `/api/v1/parliament/`. Envelope per §5.2 (`{ok,data,meta?}` +
`requestId`). Data routes are `config:{ public:true }` (§14.11) — **except
#19 `/data-quality/*`, which is `x-api-key`-gated** (internal correlation
state, §8.1/§2.6). TypeBox schemas at the boundary; `Static<typeof Schema>` is
the handler input. Each row's freshness watermark (§10) is surfaced in
`meta.asOf`.

| #   | Method · Path                            | Query / params (TypeBox)                                                                      | Response                                                            | Pagination                                                                        | Cache TTL | stmt timeout |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------- | ------------ | ------- | ------------- | -------------------------- | --- | ---- | --- |
| 1   | `GET /members`                           | `legislature?`,`chamber?`,`group?`(slug),`judet?`(slug),`q?`,`page?`,`pageSize?(≤100)`        | `{members:MemberView[]}`                                            | offset+total (bounded by legislature → cheap)                                     | 300s      | 5s           |
| 2   | `GET /members/:mandateKey`               | param                                                                                         | `MemberDetailView` (mandate+person+intervals+activity counts)       | —                                                                                 | 300s      | 5s           |
| 3   | `GET /members/:mandateKey/votes`         | `after?`,`limit?(≤100)`                                                                       | `{votes:MemberVoteView[]}`                                          | **cursor** `(vote_date,vote_key,row_index)`                                       | 120s      | 15s          |
| 4   | `GET /members/:mandateKey/control-items` | `page?`,`pageSize?(≤100)`                                                                     | `{items:ControlView[]}`                                             | offset+total                                                                      | 120s      | 5s           |
| 5   | `GET /members/:mandateKey/speeches`      | `page?`,`pageSize?(≤100)`                                                                     | `{speeches:SpeechView[]}` (quarantined excluded)                    | offset+total                                                                      | 120s      | 5s           |
| 6   | `GET /members/:mandateKey/initiatives`   | `page?`,`pageSize?`                                                                           | `{initiatives:InitiativeView[]}`                                    | offset+total                                                                      | 120s      | 5s           |
| 7   | `GET /members/:mandateKey/declarations`  | param                                                                                         | `{declarations:DeclarationMetaView[]}` (metadata only)              | —                                                                                 | 600s      | 5s           |
| 8   | `GET /persons/:personId`                 | param                                                                                         | `PersonCareerView` (mandates+intervals+totals)                      | —                                                                                 | 300s      | 5s           |
| 9   | `GET /groups`                            | `legislature?`,`chamber?`                                                                     | `{groups:GroupView[]}`                                              | —                                                                                 | 600s      | 5s           |
| 10  | `GET /groups/:groupId/members`           | `legislature?`                                                                                | `{members:MemberView[]}`                                            | — (≤ legislature size)                                                            | 300s      | 5s           |
| 11  | `GET /bills`                             | `q?`,`year?`,`finalized?`,`hasLaw?`,`actId?`,`sortBy?`,`page?`,`pageSize?(≤100)`              | `{bills:BillView[]}`                                                | offset+total                                                                      | 120s      | 5s           |
| 12  | `GET /bills/:billKey`                    | param                                                                                         | `BillDossierView` (events+docs+initiators+votes+actLinks+voteLinks) | —                                                                                 | 120s      | 15s          |
| 13  | `GET /votes`                             | `chamber?`,`outcome?`,`from?`,`to?`,`billKey?`,`q?`,`after?`,`limit?(≤100)`                   | `{votes:VoteView[]}`                                                | **cursor** `(vote_date,vote_key)`                                                 | 120s      | 5s           |
| 14  | `GET /votes/:voteKey`                    | param                                                                                         | `VoteDetailView` (tally+groupBreakdown+first page ballots)          | —                                                                                 | 120s      | 5s           |
| 15  | `GET /votes/:voteKey/ballots`            | `after?`,`limit?(≤200)`                                                                       | `{ballots:BallotView[]}`                                            | **cursor** `(row_index)`                                                          | 120s      | 5s           |
| 16  | `GET /control-items`                     | `controlType?`,`recipient?`,`author?`,`responseStatus?`,`from?`,`to?`,`after?`,`limit?(≤100)` | `{items:ControlView[]}`                                             | **cursor** (requires date window or recipient/author)                             | 120s      | 5s           |
| 17  | `GET /lineage/acts/:actId/votes`         | `roles?`(csv default `final_adoption,final_rejection`),`minConfidence?`,`includeBallots?`     | `ActLineageView`                                                    | — (bounded)                                                                       | 300s      | 15s          |
| 18  | `GET /filters/resolve`                   | `dim`(`group                                                                                  | person                                                              | constituency                                                                      | recipient | control_type | outcome | chamber`),`q` | `{matches:ResolveMatch[]}` | —   | 600s | 5s  |
| 19  | `GET /data-quality/person-candidates`    | `status?`,`page?`,`pageSize?`                                                                 | `{candidates:CandidateView[]}` (no `evidence`/`method` internals)   | offset+total                                                                      | 60s       | 5s           |
| 20  | `GET /analytics/votes/cohesion`          | `billKey?` **or** (`chamber`+`from`+`to`),`group?`                                            | `{cohesion:ParliamentGroupCohesion[]}`                              | — (vote set hard-capped at 500 votes; `InvalidInput` if bounded range exceeds it) | 60s       | 15s          |

OpenAPI: the module exports a fragment merged at `/api/v1/openapi.json`. Every
list declares `default sort` + `allowed sort keys` (§5.4). **No mutations.**

**Improvements over the old unified surface** (which had members/groups/bills/
votes/vote-detail/voting-history/profile/judete only): (a) `/persons/:id` career
view (the old surface had no person grain); (b) `/lineage/acts/:actId/votes`
(the marquee query — absent before); (c) bill dossier now attaches `actLinks` +
`voteLinks` (lineage in the detail); (d) `/control-items` standalone +
`/analytics/votes/cohesion` (PR-3/PR-5); (e) `/data-quality/person-candidates`
exposes the correlation review queue; (f) votes/ballots/control move from
offset to **cursor** so the 4M-row table never offsets deep; (g)
member-activity is split per-kind (the old `/profile` mega-endpoint fanned three
unbounded lists at once).

---

## 6. GraphQL

In-process schema stitching (§6.2). All types **`Parliament*`** prefixed
(§14.8). Connections reuse the kernel cursor encoder (§14.3). Resolvers are thin
— each calls the same usecase as the REST handler (§14.7).

### 6.1 SDL (types)

```graphql
type ParliamentMember {
  mandateKey: ID!
  chamber: String
  legislature: String
  fullName: String
  groupName: String
  group: ParliamentGroup
  constituencyName: String
  birthDate: Date
  person: ParliamentPerson
  groupIntervals: [ParliamentGroupInterval!]!
  votes(first: Int, after: String): ParliamentMemberVoteConnection!
  controlItems(first: Int, after: String): ParliamentControlItemConnection!
  speeches(first: Int, after: String): ParliamentSpeechConnection!
  initiatives(first: Int, after: String): ParliamentInitiativeConnection!
  declarations: [ParliamentDeclarationMeta!]! # metadata only
}

type ParliamentPerson {
  personId: ID!
  canonicalName: String!
  normalizedName: String!
  birthDate: Date
  confidence: ParliamentPersonConfidence! # HIGH|MEDIUM|LOW
  mandates: [ParliamentMember!]!
  careerTotals: ParliamentCareerTotals! # mandates, votes, initiatives, speeches counts
}

type ParliamentGroup {
  groupId: ID!
  chamber: String!
  name: String!
  memberCount: Int
}
type ParliamentGroupInterval {
  groupId: ID!
  group: ParliamentGroup
  validFrom: Date!
  validTo: Date
  source: String!
  voteCount: Int
}

type ParliamentBill {
  billKey: ID!
  plxNumber: String
  plxYear: Int
  senateNumber: String
  senateYear: Int
  title: String
  finalLawNumber: String
  finalLawYear: Int
  events: [ParliamentBillEvent!]!
  documents: [ParliamentBillDocument!]!
  initiators: [ParliamentMember!]!
  relatedVotes: [ParliamentVote!]!
  actLinks: [ParliamentBillActLink!]! # bill↔legal.acts (kernel cross-link, §6.7)
  voteLinks: [ParliamentBillVoteLink!]! # role-bearing vote edges
}

type ParliamentVote {
  voteKey: ID!
  chamber: String!
  voteDate: Date
  title: String
  tally: ParliamentTally!
  outcome: ParliamentVoteOutcome # ADOPTAT|RESPINS|null
  divisionNumber: Int
  billKey: ID
  lawReference: String
  groupBreakdown: [ParliamentVoteGroupBreakdown!]!
  ballots(first: Int, after: String): ParliamentBallotConnection!
  tallyMismatch: Boolean! # from attrs, surfaced as a warning flag
}
type ParliamentTally {
  pentru: Int
  impotriva: Int
  abtinere: Int
  nuAVotat: Int
  present: Int
}
type ParliamentBallot {
  rowIndex: Int!
  memberName: String
  groupName: String
  choice: ParliamentVoteChoice
  mandateKey: ID
  member: ParliamentMember
  matchMethod: String
}

type ParliamentBillActLink {
  relationshipKind: ParliamentRelationshipKind! # BECOMES_LAW|APPROVES_ACT|REJECTS_ACT|MODIFIES_ACT|REFERENCES_ACT|UNKNOWN
  targetActId: ID
  targetActType: String
  targetActNumber: String
  targetActYear: Int
  resolutionStatus: ParliamentResolutionStatus! # LINKED|CANDIDATE|AMBIGUOUS|UNRESOLVED|NOT_APPLICABLE
  confidenceLabel: ParliamentConfidenceLabel! # EXACT|HIGH|MEDIUM|LOW|NONE
  primaryMethod: String!
  # legalAct: LegalAct  — resolved by the kernel cross-link DataLoader (§6.7), NOT by importing the legal module
}
type ParliamentBillVoteLink {
  voteKey: ID!
  vote: ParliamentVote
  billKey: ID
  role: ParliamentVoteRole! # FINAL_ADOPTION|FINAL_REJECTION|REPORT_ADOPTION|AMENDMENT|PROCEDURAL|AGENDA|PRESENCE|UNKNOWN
  resolutionStatus: ParliamentResolutionStatus!
  confidenceLabel: ParliamentConfidenceLabel!
}

type ParliamentControlItem {
  itemKey: ID!
  controlType: ParliamentControlType
  title: String
  recipient: String
  itemDate: Date
  responseStatus: String
  authorName: String
  member: ParliamentMember
}
type ParliamentSpeech {
  speechKey: ID!
  spokenAt: Date
  title: String
  summary: String
  chamber: String
}
type ParliamentInitiative {
  initiativeKey: ID!
  billKey: ID
  title: String
  status: String
  promulgatedLawNumber: String
  promulgatedLawYear: Int
  bill: ParliamentBill
}
type ParliamentDeclarationMeta {
  declarationType: ParliamentDeclarationType!
  declarationDate: Date
  label: String
  fileUrl: String!
} # NO file_hash, NO content
type ParliamentActLineage { # marquee
  actId: ID!
  bills: [ParliamentBill!]!
  votes: [ParliamentVote!]!
  caveats: [String!]! # e.g. "lineage covers initiative era ~2010+"
}

type ParliamentVoteGroupBreakdown {
  groupName: String
  pentru: Int!
  impotriva: Int!
  abtinere: Int!
  nuAVotat: Int!
}
type ParliamentGroupCohesion {
  groupName: String!
  forPct: Float!
  againstPct: Float!
  abstainPct: Float!
  absentPct: Float!
  cohesionIndex: Float!
  voteCount: Int!
}
type ParliamentCareerTotals {
  mandates: Int!
  votes: Int!
  initiatives: Int!
  speeches: Int!
}

# Institutional Entity-360 slice — gated until recipient→CUI canonicalization (§4, §6.3).
# Defined now so the kernel Entity extension compiles; resolves null until then.
type ParliamentControlSummary {
  controlItemCount: Int!
  lastItemDate: Date
  topRecipient: String
}
```

### 6.2 Root Query extensions

```graphql
extend type Query {
  parliamentMembers(filter: ParliamentMembersFilter, page: OffsetPage): ParliamentMemberPage!
  parliamentMember(mandateKey: ID!): ParliamentMember
  parliamentPerson(personId: ID!): ParliamentPerson
  parliamentGroups(legislature: String, chamber: String): [ParliamentGroup!]!
  parliamentBills(filter: ParliamentBillsFilter, page: OffsetPage): ParliamentBillPage!
  parliamentBill(billKey: ID!): ParliamentBill
  parliamentVotes(
    filter: ParliamentVotesFilter
    first: Int
    after: String
  ): ParliamentVoteConnection!
  parliamentVote(voteKey: ID!): ParliamentVote
  parliamentControlItems(
    filter: ParliamentControlFilter
    first: Int
    after: String
  ): ParliamentControlItemConnection!
  parliamentActLineage(
    actId: ID!
    roles: [ParliamentVoteRole!]
    minConfidence: Float
  ): ParliamentActLineage
  parliamentResolveFilter(dim: ParliamentFilterDim!, q: String!): [ParliamentResolveMatch!]!
}
```

### 6.3 `Entity` extension + DataLoaders

Parliament does **not** add a member-level field to the kernel `Entity` type
(no member CUI). The only candidate extension is institutional:

```graphql
extend type Entity {
  parliamentControls: ParliamentControlSummary
} # gated; resolves null until recipient→CUI lands
```

resolved through `contributor.profileSlice(cui)` (§14.7) behind a CUI-keyed
DataLoader. Until recipient canonicalization exists this returns `null` (no
error) — the field is declared so the cross-source surface is forward-compatible
without a kernel edit later.

Internal DataLoaders (N+1 guards on fan-out): `personById`, `groupById`,
`memberByMandateKey` (parliament-owned). The **`legalActById`** loader is **not**
parliament-owned — it is the kernel-injected `LegalActByIdLoader` from §6.7/§11
(`deps.legalActLoader`), reused on the resolver context; parliament never builds
a legal reader of its own. The
`ParliamentMember.votes`/`speeches`/etc. connections are **not** batched across
members (each is an indexed parented scan); a list of members does not eagerly
resolve activity — only the requested member's connection field does.

### 6.7 bill↔legal cross-module link (via the kernel, not a module import)

A source module never imports another (§2 rules). `ParliamentBillActLink.legalAct`
is therefore resolved by a **kernel-owned** `LegalActByIdLoader` (reads
`legal.acts` by `act_id`), exposed on the resolver context as a shared port —
the same mechanism the `legal` module (05) uses. Parliament passes
`targetActId` to that loader; it never selects from `legal.*` in its own repo.
The reverse direction (`legal.acts → which bill became this`) is owned by the
legal module calling parliament's contributor / a kernel link registry, not by
parliament reaching into legal. This keeps the bill↔act edge a kernel cross-link
and respects the no-FK lifecycle isolation in the migration header
(`target_act_id` has no DB FK to `legal.acts`).

---

## 7. Filters — collection filter specs

Specs declared per collection; the kernel derives REST TypeBox + GraphQL input +
MCP fragment + the `ConditionBuilder[]` (§14.2). `canonicalizeFilters` output
feeds the cache key + cursor `fhash` (§14.3). Every field maps to a driving
column/index. `q` engine declared per field.

### 7.1 `votes` collection (cursor; driving `votes_chamber_date_idx`)

| Field      | Type   | Ops                   | Driving column / index                                 | REST param  | GraphQL input        | Notes                                                                                 |
| ---------- | ------ | --------------------- | ------------------------------------------------------ | ----------- | -------------------- | ------------------------------------------------------------------------------------- |
| `chamber`  | enum   | `eq`,`in`             | `votes.chamber` (+`,vote_date` idx)                    | `chamber`   | `chamber:[String!]`  | enum: `camera_deputatilor`,`senat`,`comun`                                            |
| `outcome`  | enum   | `eq`,`isNull`         | `votes.outcome`                                        | `outcome`   | `outcome`            | `adoptat`,`respins`,null                                                              |
| `voteDate` | date   | `gte`,`lte`,`between` | `votes.vote_date` (idx)                                | `from`/`to` | `voteDate:{from,to}` | bounds the index range                                                                |
| `billKey`  | string | `eq`                  | `votes_bill_idx`                                       | `billKey`   | `billKey`            |                                                                                       |
| `q`        | string | `contains`            | `votes.title`,`attrs->>'source_title'`                 | `q`         | `q`                  | **Meili-backed** when up; ILIKE/trigram fallback **requires** `chamber` or date bound |
| sort       | —      | —                     | default `voteDate desc`; allowed: `voteDate`,`voteKey` |             |                      | cursor tuple `(vote_date,vote_key)`                                                   |

### 7.2 `members` collection (offset+total; bounded by `legislature`)

| Field         | Type   | Ops        | Driving column                           | REST           | GraphQL        | Notes                                                  |
| ------------- | ------ | ---------- | ---------------------------------------- | -------------- | -------------- | ------------------------------------------------------ |
| `legislature` | string | `eq`       | `members.legislature`                    | `legislature`  | `legislature`  | default = latest; **always present** (bounds the scan) |
| `chamber`     | enum   | `eq`       | `members.chamber`                        | `chamber`      | `chamber`      | client `camera`/`senat` → DB value (resolver)          |
| `group`       | string | `eq`       | `members.group_name`/`group_id`          | `group` (slug) | `group`        | resolved via `/filters/resolve?dim=group`              |
| `judet`       | string | `eq`       | `members.constituency_name`              | `judet` (slug) | `constituency` | slug→exact name                                        |
| `q`           | string | `contains` | `members.full_name` (unaccent ILIKE)     | `q`            | `q`            | trigram/ILIKE; bounded by legislature                  |
| sort          | —      | —          | default `full_name asc, mandate_key asc` |                |                |                                                        |

### 7.3 `bills` collection (offset+total)

| Field       | Type   | Ops              | Driving column                                                                                                   | REST        | GraphQL     | Notes                                                                                                                                                                                                                                           |
| ----------- | ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `year`      | int    | `eq`,`gte`,`lte` | `bills.plx_year`/`senate_year`                                                                                   | `year`      | `year`      |                                                                                                                                                                                                                                                 |
| `finalized` | bool   | `eq`             | `bills.final_law_number IS NOT NULL`                                                                             | `finalized` | `finalized` |                                                                                                                                                                                                                                                 |
| `hasLaw`    | bool   | `eq`             | `bill_act_links.resolution_status='linked'`                                                                      | `hasLaw`    | `hasLaw`    | join to act links                                                                                                                                                                                                                               |
| `actId`     | string | `eq`             | `bill_act_links_target_idx`                                                                                      | `actId`     | `actId`     | reverse: bills that became act X                                                                                                                                                                                                                |
| `q`         | string | `contains`       | `title`,`plx_number/year`,`senate_number/year`                                                                   | `q`         | `q`         | Meili-backed; ILIKE fallback                                                                                                                                                                                                                    |
| sort        | —      | —                | default `updated_desc` (last_event_date, ISO text, DESC NULLS LAST); allowed `title_asc/desc`,`updated_asc/desc` |             |             | bills expose `lastEventDate`; member-initiatives sort by a throw-proof zero-padded ISO reorder of `registration_date_text` (DESC NULLS LAST), surfaced as `registrationDate` — NOT `to_date`/`make_date` (those throw on calendar-invalid text) |

### 7.4 `control_items` collection (cursor; bounded)

| Field            | Type   | Ops                   | Driving column                         | REST             | GraphQL              | Notes                                          |
| ---------------- | ------ | --------------------- | -------------------------------------- | ---------------- | -------------------- | ---------------------------------------------- |
| `controlType`    | enum   | `eq`,`in`             | `control_items.control_type`           | `controlType`    | `controlType`        | `question`,`interpellation`,`motion`,`unknown` |
| `recipient`      | string | `eq`,`contains`       | `control_items.recipient`              | `recipient`      | `recipient`          | resolved via `/filters/resolve?dim=recipient`  |
| `author`         | string | `contains`            | `control_items.author_name`            | `author`         | `author`             |                                                |
| `responseStatus` | enum   | `eq`,`isNull`         | `control_items.response_status`        | `responseStatus` | `responseStatus`     | PR-5 timeliness                                |
| `itemDate`       | date   | `gte`,`lte`,`between` | `control_items.item_date`              | `from`/`to`      | `itemDate:{from,to}` | **at least one bound required** (no date idx)  |
| sort             | —      | —                     | default `item_date desc, item_key asc` |                  |                      | cursor `(item_date,item_key)`                  |

### 7.5 Filter↔surface + discovery (§7.3/§7.4)

- REST: arrays = CSV (declared); ranges = `from`/`to`; no `exclude:` family in
  v1 (none of the parliament golden questions need negation — `exclude:false`
  on every field). `isNull` exposed on `outcome` and `responseStatus`
  (coverage/presence questions, mandatory per §14.2).
- GraphQL: one `input Parliament<X>Filter` per collection (kernel-derived);
  ranges are `{from,to}` objects; enums as GraphQL enums.
- **Discovery / `/filters/resolve` dimensions** (kernel infra, §7.4):
  `group` (slug→`group_name`s present in legislature), `person`
  (name→`person_id` via `persons_normalized_name_idx`, C-locale fold done in TS
  — see Risks), `constituency` (slug→county name), `recipient` (label→canonical
  recipient string; CUI deferred), `control_type`/`outcome`/`chamber` (label→enum).

### 7.7 Aggregate vote-set cap (cohesion)

`/analytics/votes/cohesion` (#20) is **not** a filterable collection but a
bounded aggregate. Its contract: resolve the `vote_key` set from `billKey`
(single bill, always ≤ a handful) **or** the `(chamber, from, to)` window off
`votes_chamber_date_idx`; **hard-cap the resolved set at 500 votes** and return
`InvalidInput("cohesion vote window too large; narrow the date range")` if
exceeded — before any `vote_records` fan-in. This is the declared ceiling the
§3.1.4 fan-in relies on (≈235k ballots worst case under the 15s timeout).

### 7.6 Golden question → filter (from `AI_AGENT_FILTER_QUESTION_CATALOG.md`)

| Catalog | Question                                  | Surface → filter                                                                                     |
| ------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| PR-1    | Bill dossier registration→law→MO          | `GET /bills/:billKey` (events+actLinks+voteLinks) → MO via the `legal` module's act detail           |
| PR-2    | Bills by status/year                      | `GET /bills?finalized=true&year=2023` (topic/domain = deferred LLM labels)                           |
| PR-3    | Votes by party & cohesion                 | `GET /analytics/votes/cohesion?billKey=…` or `?chamber=&from=&to=&group=`                            |
| PR-4    | Member voting profile                     | `GET /members/:k/votes` + `/control-items` + `/persons/:id` career totals                            |
| PR-5    | Interpellations to ministry M, timeliness | `GET /control-items?recipient=…&responseStatus=…&from=&to=`                                          |
| PR-6    | Bills with CCR/constitutionality events   | `GET /bills?q=…` + dossier `events` (event text classification; no typed CCR column in v1 → flagged) |
| —       | "Who voted for Legea 423/2023"            | resolve act via legal → `GET /lineage/acts/:actId/votes?includeBallots=true`                         |

---

## 8. MCP tools

`shell/mcp/`; registered into the kernel MCP server. TypeBox in+out; handler
calls a usecase; output `{ ok, kind, query, link, item|items, summary? }`
(§6.3). Rate-limited; bounded sizes; **never** emit excluded columns (§2.6).

### 8.1 Discovery — `resolve_parliament_filters`

`in`: `{ dim: 'group'|'person'|'constituency'|'recipient'|'control_type'|'outcome'|'chamber', q: string, legislature?: string }`.
`out`: `{ ok, kind:'resolution', items:[{value,label,kind,score}] }`. Wraps
`/filters/resolve`. Romanian names → filter values (the §7.4 dimensions).

### 8.2 `get_parliament_law_lineage` (marquee)

`in`: `{ actId?: string, actCitation?: {type,number,year}, roles?: VoteRole[],
includeBallots?: bool }`. Resolves citation→`act_id` (via the kernel legal
loader), runs `getLineageForAct`.
`out`: `{ ok, kind:'lineage', item:{ act, bills[], votes[{voteKey,chamber,
voteDate,role,outcome,tally,sourceWarnings[]}], memberVotes?[{personId,name,
groupAtVote,choice,matchMethod}] }, link, summary }`.
`link`: `/parliament/lineage/acts/<actId>`. `summary`: "_Legea 423/2023_ came
from bill 12760; final adoption vote 2022-05-04 (CD): 275 for / 1 abținere / 1
absent; 277 ballots person-resolved." **Caveats included** when the act's era
predates dense lineage (~2010+) — never a silent empty.

### 8.3 `get_parliament_member_activity`

`in`: `{ mandateKey?: string, personId?: string, kinds?: ('votes'|'control'|'speeches'|'initiatives')[], limit?: int(≤100) }`.
`out`: `{ ok, kind:'member_activity', item:{ member|person, votes[], control[],
speeches[], initiatives[] }, link:'/parliament/members/<key>', summary }`.
Person-grain (`personId`) fans across all the person's mandates.

### 8.4 `rank_parliament_vote_cohesion`

`in`: `{ billKey?: string, chamber?, from?, to?, group? }` (vote set bounded
first; **hard cap 500 votes** — returns `{ok:false,error:'InvalidInput'}` if the
bounded range exceeds it, mirroring REST #20). `out`: `{ ok, kind:'cohesion',
items:[{group, forPct, againstPct, abstainPct, absentPct, cohesionIndex,
voteCount}], link, summary }`. PR-3.

(Bills + votes discovery for agents is covered by the discovery tool + the
lineage/activity tools; a thin `search_parliament` wraps the search lane, §9.)

---

## 9. Search integration

Owned `doc_type`s (from `…search_doc_types` migration; the **scrapper** `search`
lane writes `search.documents`, the server only reads/queries):

| `doc_type`                  | Source rows                  | `title`            | `body`                   | `cuis`                             | `doc_date`      |
| --------------------------- | ---------------------------- | ------------------ | ------------------------ | ---------------------------------- | --------------- |
| `parliament_bill_dossier`   | `bills` (+ dossier)          | bill title         | status_text + key events | — (no CUI)                         | last_event_date |
| `parliament_bill_law_link`  | `bill_act_links` linked      | "PL-x → Legea N/Y" | citation + method        | —                                  | final_law year  |
| `parliament_control_item`   | `control_items`              | title              | recipient + author       | recipient CUI (when canonicalized) | item_date       |
| `parliament_speech_segment` | `speeches` (non-quarantined) | speech title       | summary                  | —                                  | spoken_at       |

- **Meilisearch** — instant prefix/autocomplete on bill titles + member names
  (index `parliament_bills`, `parliament_members`); used by `/filters/resolve`
  name dimensions when up.
- **OpenSearch** — relevance/full-text over the four doc types + terms
  aggregations (by chamber, year, control_type).
- **Postgres fallback** — `search.documents` ILIKE/trigram + the in-schema
  ILIKE on `bills`/`votes`/`members` when both engines are down (the old
  surface's only mode). Bounded as in §7 (`q`-only requires a bound on the
  in-schema path).
- **Semantic** — capability-gated (§14.5): no parliament vector column in the
  snapshot (fork #8). Any semantic field returns `null` +
  `caveats:['semantic search unavailable']`; never errors.

Index names: `parliament_bills`, `parliament_members` (Meili);
`search.documents` filtered by the four `doc_type`s (OpenSearch). Speech
segments are separately gated by the loader on member/date quality
(`quarantined=false`), so the server never has to filter them out.

---

## 10. Sync / freshness impact on serving

Loader cadence (`PARLIAMENT_NOTES.md` fork #4): weekly raw refresh →
`parliament:load-prod --incremental` + `--derive-only` + `parliament:correlate`.
The source is mutable (bills move through phases, members churn, new votes
append) — so:

- **`meta.asOf` watermark.** Per §14.11, the module reads the parliament
  domain's loader-completion stamp (from `etl.load_runs` / `system_control`) at
  boot + on a short interval and surfaces it as `meta.asOf` on every read; it
  also busts the in-process cache when the stamp advances. **If no stamp signal
  is wired at cutover, TTL-only is the interim** (stated explicitly) — the TTLs
  in §5 (60–600s) are sized for a weekly loader, so staleness is bounded to the
  TTL even without the stamp.
- **Lineage / link freshness.** `bill_act_links` upgrade as the legal corpus
  backfills (`unresolved`→`linked` on re-run). The lineage endpoints surface the
  link's `resolutionStatus`/`confidenceLabel` so a client sees when a link is
  still a candidate — no "as-of" lie.
- **Cohesion / derived rollups** are computed at request time from base tables
  (no MV), so they are always as-fresh-as the last load; no separate refresh
  contract.

---

## 11. Wiring

```ts
makeParliamentModule(deps: {
  db: Kysely<ProdDatabase>;
  cache: CachePort; rateLimiter: RateLimiterPort;
  search: SearchClients;             // meili + opensearch (capability-gated)
  legalActLoader: LegalActByIdLoader; // kernel-owned cross-link (§6.7)
  watermark: WatermarkPort;          // etl/system_control read for meta.asOf
}): ParliamentModule  // { restPlugin, graphql:{typeDefs,resolvers}, mcpTools, contributor, repos }
```

- **Env additions:** none module-specific beyond kernel `PROD_DATABASE_URL`,
  `MEILI_*`, `OPENSEARCH_URL`. Module enablement via the kernel feature-flag
  list. (No separate `PARLIAMENT_DATABASE_URL` — the kernel's single typed pool
  over `transparenta_prod` replaces the old unified-only pool; the
  `PARLIAMENT_NOTES.md` "dedicated pool" concern is resolved by the kernel's
  one-pool-over-the-whole-DB design.)
- **build-app registration:** construct after the kernel; register restPlugin
  under `/api/v1/parliament`, merge GraphQL slice, register MCP tools, register
  the contributor (`source:'parliament'`) into the kernel registry. Order is
  data-independent.
- **Legacy superseded:** the unified-explorer parliament surface
  (`modules/unified/.../parliament-*`). The client currently calls
  `/api/v1/unified/parliament/*`; the new prefix is `/api/v1/parliament/*`. The
  client live module's response shapes are preserved on the overlapping
  endpoints (members/groups/bills/votes/vote-detail/voting-history/profile) so
  the client migration is a base-path + minor-shape change, not a rewrite
  (`PARLIAMENT_CODEBASE_NOTES.md` §4). New endpoints (persons/lineage/
  control-items/cohesion/data-quality) are additive.

---

## 12. Testing

- **Unit** (`tests/unit/parliament/`): usecases with mocked port; filter spec→SQL
  compilation snapshots for the 4 collections; cursor encode/decode incl. `fhash`
  mismatch → `InvalidInput`; mappers (date `::text`, bigint→string, tally shape,
  quarantined exclusion, declaration metadata strips `file_hash`).
- **Integration** (`tests/integration/parliament/`): REST + GraphQL + MCP
  against a seeded fixture schema; **tri-surface equivalence** — same filter via
  REST query, GraphQL input, MCP input returns identical rows (the
  `canonicalizeFilters` contract). A **`vote_records` guard test**: assert no
  query path issues an unparented scan of `vote_records` (plan check / EXPLAIN
  asserting the mandate or pk index is used).
- **Golden filters**: PR-1…PR-6 + the lineage query as integration cases. The
  marquee assertion reproduces the validated case: act _Legea 423/2023_ →
  lineage → 277/277 ballots person-resolved.
- **Privacy test (tri-surface — REST, GraphQL, AND MCP)**: assert no surface
  emits `birth_date_text`, `birth_date_parse_method`, `persons.cluster_key`,
  `member_declarations.file_hash`, declaration content, quarantined speeches, or
  identity-candidate `evidence`/`method` by default. The MCP arm specifically
  inspects `get_parliament_member_activity` person/member output objects. The
  data-quality endpoint test also asserts it is `x-api-key`-gated (not public).

---

## 13. Open questions / risks

1. **C-locale name folding (carry-over gotcha).** `transparenta_prod` is C-locale;
   `lower()` does not fold `Ş/Ă/Î` (a naive SQL name match reads 64% vs 99.2%).
   Member/person name search **must normalize in TS** (the loader's
   `normalizeMemberName`) before hitting `persons_normalized_name_idx` — the repo
   stores `normalized_name` already folded, so resolve queries match the stored
   folded form. **Risk if forgotten:** silent under-matching. Encoded in the
   `/filters/resolve` person dimension.
2. **`vote_records` has no date/choice index** — the entire pagination story
   depends on parenting by `vote_key`/`mandate_key` (§3.1). Any future
   "all ballots filtered by choice/date" feature needs an _earned_ index first;
   flagged, not pre-built.
3. **bill↔legal cross-link timing.** `bill_act_links.target_act_id` has no DB FK
   (intentional, lifecycle isolation). The kernel `LegalActByIdLoader` must
   tolerate a `target_act_id` that no longer resolves (legal rebuild reassigned
   it) — return `null` + a `resolutionStatus` already on the link row, never
   error. Needs the `legal` module (05) to expose the kernel loader; **cross-plan
   dependency** flagged to the orchestrator.
4. **Recipient→CUI deferred** ⇒ parliament's `Entity` contribution and
   `presenceFor` are null until canonicalization lands. Confirm with the
   orchestrator that an entity-360 with no parliament slice (vs an error) is the
   accepted v1 behavior. (Plan assumes yes per §4.4 graceful-degrade.)
5. **No typed bill-event class / CCR column (PR-6, PR-1 event_type).** The
   catalog wants `bill_event_typed`/`bill_status`; v1 has raw `bill_events.description`
   only. PR-6 ("CCR events") is answerable by text classification, not a typed
   filter — flagged as a loader/enrichment follow-up, not built in the server.
6. **`comun` (joint) chamber.** Votes carry `chamber='comun'`; the old surface
   folds joint sittings under the client `camera` bucket. The new module exposes
   `comun` as a first-class chamber enum value (improvement) but the
   client-compat mapping (`camera` includes `comun`) is preserved in the resolver
   for the legacy endpoints' shape. Confirm the client can adopt a distinct
   `comun` value, else keep the fold.
7. **Cohesion endpoint cost.** `/analytics/votes/cohesion` over a date window
   fans into `vote_records` by the bounded `vote_key` set; a very wide window ×
   chamber could touch many votes. Mitigation: cap the vote set (e.g. ≤ N votes
   per request, declared) before the `vote_records` fan-in; 15s timeout. Confirm
   the cap with the orchestrator (suggest 500 votes / ~235k ballots ceiling).

```

```
