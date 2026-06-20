# Parliament Module — Data-Accuracy & API Audit

> **Status:** Findings report (read-only audit — no code changed)
> **Date:** 2026-06-20
> **Scope:** Parliament GraphQL (`/api/v1/graphql`) + MCP (`/api/v1/mcp`) surfaces on the redesign server.
> **Target env:** `localhost:3001` (postgres `ok`, meilisearch `ok`, opensearch `ok`).
> **Companion design doc:** [`04-parliament.md`](./04-parliament.md)
> **Data origin:** External scrapper repo (`hack-for-facts-eb-scrapper`) → shared read-only Postgres. The server never writes parliament data; several findings therefore trace to the scrapper, not this server.

---

## Resolution status (2026-06-20)

A 7-agent team re-verified every finding against the live API + serving DB + code
(codex gpt-5.5 xhigh reviewed the fix strategy AND the diff). **Server-origin bugs
are FIXED** on branch `fix/parliament-qa-audit` (server repo, 3 commits, +unit/golden
tests). **Scrapper/data-origin bugs are GATED** (need approval before any
reload/recompute) and tracked in
`hack-for-facts-eb-scrapper/prod-db/PARLIAMENT_QA_DATA_OPS.md`.

| ID | Status | Where |
| -- | ------ | ----- |
| C1 | ✅ DONE — scrapper SQL recompute-from-nominal executed (35 inflated tallies corrected, 0 regressions); server M1 detector wired | data-ops P0 |
| H1a/H1b | ✅ FIXED | server |
| H2 | ✅ FIXED — 9 root fields nullable (codex found 3 beyond the 6) | server |
| H3 | GATED — senat fişă detail-port | data-ops P1 |
| H4 | ✅ FIXED — SDL signposts finalized vs hasLaw | server |
| H5 | ✅ DONE — parseFinalLaw wired into senat lane + reloaded; 1,575 senat bills now carry final_law_number/year | data-ops P1 |
| H6 | ✅ FIXED | server |
| H7 | ✅ FIXED | server |
| H8 | ✅ FIXED — ballots-200 cap documented; clamp kept (codex D2) | server |
| H9 | ✅ FIXED — 1000 cap dropped | server |
| H10 | ✅ FIXED — full member shape | server |
| H11 | ✅ DONE — interpelari attribution backfilled (split_pass author/mandate 0→41,929 via sender_idm→2:leg:idm; loader fix `main 7aaea29` + serving recompute; 0 FK orphans, idempotent) | data-ops P2 |
| H12 | GATED — net-new senate control/decl extraction | data-ops P3 |
| H13 | ✅ FIXED | server |
| H14 | ✅ FIXED — caveats report omitted; roles:["all"] widens. **Default unchanged — changing it is escalated to the user** | server |
| H15 | ✅ DONE (data) — `correlate --stages bill-act-links` backfilled 1,498 senat act-links (0→1,498 linked, 77 unresolved, 0 ambiguous; cdep 3,410 unchanged; senat:606-2024→act 162403). Server kernel resolver still DEFERRED (codex D6) | data-ops P1 |
| M1 | ✅ FIXED — raw-attrs presence (audit/agent `!= null` would also have failed) | server |
| M2 | ✅ FIXED — reject kept; H2 isolates it (audit overstated "unimplemented") | server |
| M3 | ✅ DONE — collapsed into H5 (parseFinalLaw is date-aware); 837 senat bills have year≠senate_year proving the date-derived year | data-ops P1 |
| M4 | ✅ FIXED — SDL clarity (field raw vs bucketed filter) | server |
| M5 | ✅ server doc (known-null); extraction GATED | server + data-ops P2 |
| M6 | RECLASSIFIED — not a bug (date absent at source); documented | server doc |
| M7 | ✅ FIXED — registry resolves historical slugs (audit overstated) | server |
| M8 | GATED — slugifier dot-collapse | data-ops P3 |
| M9 | ✅ DONE — control-stream unification: combined_pass refined to question 32,962 / interpellation 6,751 via item_number A/B (127 no-suffix kept question_or_interpellation); provenance preserved | data-ops P2 |
| M10 | ✅ FIXED — declarationYear + synthesized label | server |
| M11 | ✅ FIXED — SDL doc (statusText raw; use status filter) | server |
| M12 | ✅ FIXED — largest-remainder → sum 100.00 | server |
| M13 | ✅ FIXED — cohesionIndex nullable, null when no decided votes | server |
| M14 | ✅ FIXED — relatedVotes @deprecated → voteLinks | server |
| M15 | ✅ FIXED — caveats carry real content | server |
| M16 | ✅ FIXED — BallotConnection.total. **OVERSTATED**: ballotsTotal/Resolved are not dead (conditional on includeBallots) | server |
| M17 | NOT-A-BUG — latent only (DDL enforces NOT NULL); left as-is | — |
| M18 | DECISION — REST is a platform-wide roadmap item, GraphQL+MCP-first by design | doc/roadmap |

**Audit claims corrected by the investigation (verified):** C1 scope 13/2-days →
**32 votes / 5 days**, root cause = senat.ro group-totals inflation (NOT a double
read); H3 stubs 25% → **47% of senat**; H13 senat divergence 9/9 → **524/524 (100%)**;
M16 "dead fields" overstated; M17 "live cascade" → latent; M6 "fixable" → source-absent;
M7 "non-empty group returns 0" → historical (0 current) groups; M8 "12 double-counted"
→ same 12 people under two slugs; **§6 "ballots dropped server-side" DENIED** (4,751
unmatched are kept, 0.1%); H11 reframed (provenance cut, LOADER-only); M2 "overflow
partial unimplemented" denied (design specifies reject-on-overflow). 3 of the 13 C1
voteKeys in §2 are transcription typos (transposed UUID digits).

---

## 0. Method

A team of **8 specialist agents** ran in parallel, each owning one analytical angle, with mandatory cross-checking between adjacent areas. The audit executed **~620 GraphQL + ~50 MCP** requests at production scale:

| Dimension audited                            | Scale           |
| -------------------------------------------- | --------------- |
| Promulgated bills (full enumeration)         | 5,203           |
| Unique votes (3 chambers, 2020–2026)         | 4,855           |
| Ballots sampled for `matchMethod`/identity   | 14,800          |
| Members (2024 + 2008/2012/2016/2020 samples) | 672             |
| Act lineages walked end-to-end               | 50              |
| Legislatures covered                         | 7 (2008 → 2024) |

The 11 core techniques applied per area: cross-fetch entity 360°, bidirectional cardinality, sub-filter sum, mathematical-invariant checks (tally arithmetic, Rice cohesion), cross-source reconciliation (snapshot vs derived, tally vs ballot count), cursor pagination stress, filter commutativity/exhaustiveness, edge/boundary cases, statistical-outlier detection, and duplicate-natural-key scans.

**Self-validation:** two agent claims were cross-checked and **corrected** (see §5) — one bug retracted, one re-characterized. The two headline bugs (C1, H9) were independently re-verified by the coordinator after the run.

---

## 1. Executive summary

- **35 distinct bugs** found: **1 CRITICAL, 15 HIGH, ~11 MEDIUM, ~8 LOW**.
- **~20 data-quality issues** (non-bug but actionable).
- **~50 integrity tests PASSED**, establishing a solid baseline of what works.
- Two coherent bug clusters dominate the surface:
  1. **The "group namespace" cluster** (H1, H6, H7, H9, H10, M7, M8) — the same root cause (party-NAME vs chamber-slug identifiers never reconciled) manifests as a broken resolver, a broken filter, a truncation, a partial object, and missing registry entries.
  2. **The "Senate data deficit" cluster** (C1, H3, H5, H12, H15, M3) — the upper chamber has corrupted tallies (×2), relational stub bills, missing `finalLawNumber`, zero control/declaration coverage, and is unreachable from lineage. Most of this traces to the **scrapper**, not the server.
- The single most fragile server-side contract issue is **H2** (non-null return types nullify entire GraphQL queries on any guard error) — it turns every input-validation failure into a query-level outage.

---

## 2. CRITICAL

### C1 — Senate tally doubled (×2 multiplier) on two sitting days

**Severity:** CRITICAL · **Area:** votes/ballots · **Origin:** scrapper (stored data)

For **13 senat votes** on **2022-05-09** (3 of 8) and **2022-06-15** (10 of 10 — the entire day poisoned), the `tally` object's `pentru`/`impotriva`/`abtinere` are **exactly 2×** the real per-ballot / per-group count. `present` is correct. As a consequence `tally.pentru > tally.present` — an arithmetic impossibility (more FOR votes than members present).

**Evidence (independently re-verified):**

- `senat:0DE98266-8390-4FC7-8E55-CC15D19D0175` → `tally.pentru=168`, `tally.present=88`, `ΣgroupBreakdown.pentru=84`. Ratio = **2.000 exactly** in 100% of the 13 cases.
- Worst cases exceed the entire 134-seat Senate: `senat:0DE98266` (+80), `senat:E06B40C8` (`pentru=186`, `present=108`, +78).
- Corruption is in **stored data**: it also surfaces through `parliamentBill(...).voteLinks.tally`, so it is not a resolver-layer artefact.

**Affected voteKeys (full list):**

```
senat:EBD8CF70-FC73-48E4-8C0C-77AE549AC813   senat:D380F5FC-FEF8-436D-86DB-399298157DC8
senat:BD41C141-C8A2-4906-A4D2-B020F0119CEA   senat:46686B57-4523-4B5C-9EC3-86F9AA350E4A
senat:37D72637-689B-41A6-AA4F-A7A22825C1C6   senat:2888A90C-C76E-46BF-BB37-11F71454402E
senat:1BB8532C-6A7D-440C-8B28-EAF8D68ADA9B   senat:183B23C9-9071-4C21-8879-2C60C1A68D43
senat:0DE98266-8390-4FC7-8E55-CC15D19D0175   senat:023267D7-1EB2-4C58-A2F9-B3B999444672
senat:E06B40C8-F501-442A-8D92-4CFA99FAC652   senat:D9AA09F3-1150-4D90-808D-C902946DDE76
senat:0DBB44F8-23D1-4B9C-B659-8ECB816B5E46
```

**Repro:**

```graphql
{
  parliamentVote(voteKey: "senat:0DE98266-8390-4FC7-8E55-CC15D19D0175") {
    tally {
      pentru
      impotriva
      abtinere
      nuAVotat
      present
    }
    groupBreakdown {
      groupName
      pentru
      impotriva
      abtinere
      nuAVotat
    }
  }
}
```

**Impact:** Any consumer trusting `tally.pentru` for these 13 laws reports double the actual yes-votes and can flip majority perception. Rice/cohesion computed from `tally` are garbage. (Note: the `parliamentVoteCohesion` endpoint is **immune** — it reads `vote_records` directly, not `votes.tally`; see §6.)

**Suspected root cause:** Scrapper concatenated two reads of the same roll-call for those two sitting days (initial + verification pass, or a joint-session merge mis-tagged as senat). Pattern is exactly ×2 across all three non-null fields and only `present` is immune (sourced from a different field).

**Fix:** scrapper-side dedup of the roll-call read for 2022-05-09 / 2022-06-15; recompute the 13 `votes.tally` rows. Server-side: wire `tallyMismatch` (M1) so this class of corruption is detectable going forward.

---

## 3. HIGH severity

### H1 — `group` relation resolver returns null (100% global)

**Severity:** HIGH · **Area:** members/groups · **Origin:** server (`src/modules/parliament/shell/graphql/resolvers.ts`)

The `group` field is null for **472/472 (100%)** of 2024 legislature members and **200/200 (100%)** of sampled 2008–2020 members — every legislature, both chambers, current and non-current. `groupName` (denormalized string) is populated on 472/472; `groupIntervals[].group` is null on **1250/1250** intervals. Two distinct defects:

- **H1a — `ParliamentMember.group`** (`resolvers.ts:282`): resolver calls `listGroups(deps, legislature, undefined)` with `undefined` chamber → routes to the whole-parliament branch of `listGroupCounts` where `groupId` = the party **NAME** (`"AUR"`). The member's `groupId` is the chamber-suffixed **slug** (`"aur-senat"`). `.find(g => g.groupId === parent.groupId)` never matches.
- **H1b — `ParliamentGroupInterval.group`**: the resolver map is **entirely missing** (`resolvers.ts` defines no `ParliamentGroupInterval:` entry) → GraphQL falls back to the default resolver → `parent.group` → `undefined` → `null`.

**Fix:**

- H1a: pass `parent.chamber` (or build the group from the member's already-populated `groupId`/`groupName`/`chamber` to avoid an N+1 `GROUP BY` per member).
- H1b: add a `findGroup(groupId)` repo method (mirror the proven `group_id = $1 OR group_name = $1` match already in `listGroupMembers`) and register a `ParliamentGroupInterval.group` resolver.
- Add resolver unit tests (currently **zero** coverage for either field — the nullable SDL let this ship silently).

### H2 — Non-null return types nullify entire GraphQL queries on any guard error

**Severity:** HIGH (systemic) · **Area:** GraphQL contract · **Origin:** server

`parliamentVotes`, `parliamentControlItems`, `parliamentVoteCohesion`, `parliamentMembers`, `parliamentBills` (and `parliamentPersonCandidates`) are all declared **NON_NULL (`!`)**. When any of their input guards rejects, the thrown error cannot be represented as `null` for the field, so it **propagates up and nullifies the root `Query`** — destroying every sibling field in the request.

**Reproduced variants:**

- Unbounded `parliamentControlItems` (BOUND guard) alongside `parliamentActLineage` → `data` became entirely `null` (lineage result lost).
- Cohesion mode-guard (both `billKey` and `chamber+from+to`) alongside `parliamentGroups` → groups wiped.
- `parliamentPersonCandidates` without API key throws `FORBIDDEN` for **every** public caller — including it in any query nukes the whole response, and there is no "correct" input a public caller can send.
- Type-coercion errors (`chamber:{eq:123}`) and garbage cursors/dates also propagate.

**The proven-safe pattern already ships:** `parliamentActLineage` is nullable → its errors isolate to the field (matrix row 08 in the contract report). The same usecase errors return a graceful `{ok:false, error}` in MCP (HTTP 200) but nullify the entire GraphQL query — a stark parity asymmetry.

**Fix:** make the five list/cohesion fields nullable (drop the `!`), or return validation errors in-band (e.g. an `{ ok: false, error }` envelope) instead of throwing. Reserve `!` for fields that can never fail.

### H3 — Senate bills are relational stubs

**Severity:** HIGH · **Area:** bills · **Origin:** scrapper

100% of `senat:*` promulgated bills have `billType=null`, `initiators=[]`, `events=[]`, `documents=[]` (49/49 sampled). Only `title`, `statusText`, `senateNumber`, `senateYear` are populated. ~25% are bare stubs with no relations at all (`senat:255-2021`, `senat:310-2021`, `senat:482-2021`). cdep bills in the same page: 0/51 null on these fields. ~75% of senat bills do carry derived `actLinks`+`voteLinks` (computed downstream from `statusText`).

**Impact:** sponsorship, procedural-timeline, committee-throughput and document analytics are impossible for the upper chamber; cross-chamber comparisons silently drop the senat side. Affects ~1,575 promulgated + senat-rejected/in_progress.

### H4 — `hasLaw` filter ≠ `finalLawNumber` presence (218-law divergence)

**Severity:** HIGH · **Area:** bills/filters · **Origin:** server + scrapper

`hasLaw:{eq:true}` = 3,410 (bills with a `linked` actLink). `finalized:{isNull:false}` = 3,628 (bills with non-null `finalLawNumber`). The **218** bills with a law number but no linked act are cdep bills whose act-registry match failed (`resolutionStatus` = `unresolved`/`not_applicable`). The schema does not distinguish these semantics.

**Repro:** `{ a: parliamentBills(filter:{hasLaw:{eq:true}},pageSize:1){total} b: parliamentBills(filter:{finalized:{isNull:false}},pageSize:1){total} }` → 3,410 vs 3,628.

### H5 — 1,575/5,203 (30%) promulgated bills have null `finalLawNumber`

**Severity:** HIGH · **Area:** bills · **Origin:** scrapper

100% of affected bills are **Senate** (`senat:*`); 0 cdep exceptions across the full 5,203 enumerated set. `statusText` contains a parseable `nr.X` in 60/60 sampled (format `"A devenit Legea nr.87/28.05.2026 publicatã în M.O. nr.456/..."`). The number is trivially extractable but never written to the structured field.

**Impact:** the `finalized` filter, law-number lookups, and bill↔legal-act linkage all silently miss ~1/3 of all laws. (Note: the laws are still correctly bucketed as `status=promulgated` — only the structured field is empty.)

### H6 — `group` filter silently drops the slug form

**Severity:** HIGH · **Area:** members/filters · **Origin:** server

`ParliamentMembersFilter.group:{eq:"pnl-senat"}` → **0** results. Only the UPPERCASE party-NAME form (`"PNL"`, `"PSD"`, `"AUR"`) matches. The slug is exactly what `member.groupIntervals[].groupId` emits — so the obvious round-trip (read a member's interval groupId, feed it back into the filter) returns nothing. No validation error; just zero rows. `in:["aur-senat",…]}` is also slug-blind.

**Repro:** `{ slug: parliamentMembers(pageSize:1,filter:{group:{eq:"pnl-senat"}}){total} name: parliamentMembers(pageSize:1,filter:{group:{eq:"PNL"}}){total} }` → 0 vs 78.

### H7 — `members.group.in:[]` / `members.judet.in:[]` treated as NO-FILTER

**Severity:** HIGH · **Area:** members/filters · **Origin:** server

Empty `in:[]` has **opposite semantics** depending on the field. For members' virtual `group`/`judet` it returns the entire unfiltered set (472 of 472); for every other filter (`votes.chamber.in:[]`, `bills.status.in:[]`, `bills.billType.in:[]`, `controlItems.controlType.in:[]`) it correctly returns 0. A client building `members(filter:{group:{in:selectedGroups}})` with `selectedGroups` initially empty (typical "no checkboxes ticked" UI) silently receives ALL members instead of none.

### H8 — Invalid `pageSize`/`first` silently coerced (not rejected)

**Severity:** HIGH/MED · **Area:** pagination · **Origin:** server

- **F3 (HIGH):** `pageSize:0` / `pageSize:-1` on offset collections return **20 rows** (the default; `0 ?? 20` falsy fall-through). No error.
- **F4 (MED):** `pageSize:N` for N>100 is silently capped at 100 while `total` still reports the true count. No `totalEstimated` warning.
- **F5 (MED):** cursor `first:0` / `first:-1` returns **1 edge** (not 0).
- **F6 (LOW):** `first:N>100` is capped at 100 for root collections, but `vote.ballots(first:101)` is **not capped** (returns all up to total) — inconsistent.

### H9 — `parliamentGroupMembers(groupId)` truncates at exactly 1000

**Severity:** HIGH · **Area:** members/groups · **Origin:** server

`parliamentGroupMembers(groupId:"PSD")` → **1000** members, but the chamber-slug union (`psd-camera_deputatilor`=925 ∪ `psd-senat`=411) = **1336** → **336 rows silently dropped** (independently re-verified). The return type is a bare `[ParliamentMember!]!` list with **no `total` field**, so consumers cannot detect truncation. `current:true` / `legislature` filters bypass the cap.

**Suspected cause:** a `.limit(1000)` guard on the un-filtered whole-history branch.

### H10 — `bill.initiators` returns partial member objects (4 fields always null)

**Severity:** HIGH · **Area:** members/bills · **Origin:** server

Members reached via `parliamentBill.initiators` are missing `legislature`, `normalizedName`, `constituencyName`, `birthDate` — null for **49/49** initiators on every bill tested — while the **same** `mandateKey` fetched via `parliamentMember`, `parliamentMembers(q)`, or `vote.ballots[].member` is fully populated. The member object shape is inconsistent depending on entry path; code doing `initiator.normalizedName` breaks silently.

**Fix:** the `initiators` resolver hydrates a reduced summary row instead of delegating to the full `ParliamentMember` resolver. Delegate (or full-field-map) so the shape is uniform.

### H11 — Interpellations lose `member` + `authorName` (invisible on MP profiles)

**Severity:** HIGH · **Area:** control items · **Origin:** scrapper/server

`cdep_interpelari` control items have `authorName=null` AND `member=null` for **100%** of rows; the `cdep_control_detail` (question) stream resolves both 100%. Consequently `member.controlItems` returns **only questions** — interpellations are invisible on every MP profile and cannot be attributed to any MP (including all 2026 activity).

### H12 — Senat chamber has ZERO control items and ZERO declarations

**Severity:** HIGH · **Area:** control/declarations · **Origin:** scrapper

The entire upper chamber (134 seats, 29% of parliament) is absent from both the `control_items` and `member_declarations` datasets. Senators have votes/speeches/initiatives only. Cross-chamber oversight comparison is impossible.

### H13 — Lineage misreports `billKey` for every senat-chamber vote

**Severity:** HIGH · **Area:** lineage · **Origin:** server

For a senat-chamber vote, `parliamentActLineage(actId).votes[].billKey` returns the **CDEP bill key** that owns the voteLink (e.g. `"22774"`), NOT the vote's actual `billKey` (e.g. `"senat:445-2025"`). **9/9** senat lineage votes diverge; **0/30** cdep votes diverge. A consumer walking lineage → `parliamentBill(billKey)` for a senat vote fetches the **wrong bill** (the cdep twin).

**Cause:** the lineage resolver iterates bills and re-uses the iteration bill's `billKey` instead of re-resolving the vote's own `billKey`.

### H14 — Lineage silently omits ~19% of voteLinks (incl. high-confidence ones)

**Severity:** HIGH · **Area:** lineage · **Origin:** server

`parliamentActLineage(actId).votes[]` only contains votes with `role ∈ {final_adoption, final_rejection}`. Other `linked` voteLinks — including **high-confidence `procedural`** votes (committee referrals, article-by-article) — are silently dropped. Across 30 acts: 48 direct `bill.voteLinks` vs 39 lineage votes → 9 omissions in 30% of lineages. The filter is undocumented and `bill.voteLinks` does not apply it, so the two views disagree.

### H15 — Senate-originated laws are unreachable from the lineage API

**Severity:** HIGH · **Area:** lineage · **Origin:** scrapper/server

0/49 senat bills have a `linked` actLink (`resolutionStatus="not_applicable"`, `targetActId=null`, `legalAct=null`). There is no public `(lawNumber, lawYear) → actId` resolver, so ~1,575 promulgated senat laws (the H5 cohort) are entirely absent from the lineage graph — neither forward (act→bill) nor reverse (bill→act). Combined with H3, the senat chamber has **no end-to-end journey visibility**.

---

## 4. MEDIUM severity

| #       | Bug                                                             | Evidence / notes                                                                                                                                                                              |
| ------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1**  | `tallyMismatch` flag is dead code                               | `false` for **0/4,855** votes — including all 13 ×2 corrupted (C1) and 3 phantom+1 votes it should flag. Either wire it or remove it.                                                         |
| **M2**  | Cohesion hard-throws >500 votes (no overflow flag)              | `cdep 488 OK / 510 ERR`. Design's `overflow:true` partial is not implemented; a full-year window is unusable. Plus H2 nukes the query. Cap is on **votes**, not ballots.                      |
| **M3**  | Senat `statusText` embeds publication DATE, not law-year        | `nr.87/28.05.2026`; naive `nr.(\d+)/(\d{4})` yields wrong year for **53%** of senat backfill. The law number is reliable; the year needs the date segment.                                    |
| **M4**  | `billType` filter enum vs field free-text; senat unclassifiable | Filter accepts `government`/`parliamentary`; field returns descriptions. Senat=`null` → **3,154 bills** match neither bucket.                                                                 |
| **M5**  | Event `committee` always null                                   | 0/3,102 populated. Committee-stage analytics unavailable despite the field.                                                                                                                   |
| **M6**  | 54% of cdep events have null `eventDate`                        | Position-ordering intact (0 violations in 1,155 events) but date chronology broken for half the timeline; SLA/time-to-promulgation biased.                                                    |
| **M7**  | `parliamentGroups` under-lists 13/29 interval groupIds          | Active current senate groups (POT, PIR) absent from the registry → `groupMembers("POT")` returns 0 for a non-empty group. Registry vs derived namespaces not reconciled.                      |
| **M8**  | Duplicate slug `sos-ro-senat` vs `s-o-s-ro-senat`               | 12 senators double-counted; slugifier treats `S.O.S RO` ≠ `SOS RO`.                                                                                                                           |
| **M9**  | Two divergent control-item streams                              | `combined_pass`→`question_or_interpellation` w/ attribution; `split_pass`→real `question`(97%)/`interpellation`(3%) w/o. controlType filter returns inconsistent populations.                 |
| **M10** | `declarationDate` + `label` 100% null                           | Year is only recoverable by parsing the `fileUrl` path.                                                                                                                                       |
| **M11** | Initiative `status` = free-text Romanian scrape                 | 25+ distinct values incl. typos (`raportdepus`, `adoptatde Senat`) and law numbers leaked in (`Lege 53/2026`).                                                                                |
| **M12** | Cohesion percentages don't always sum to 100                    | 30/437 rows (6.86%) — naive per-field rounding, never largest-remainder.                                                                                                                      |
| **M13** | `cohesionIndex=0` is misleading 76% of the time                 | Abstain/absent-only groups (0 for & 0 against → 0/0→0) flagged "maximally divided"; 75% of rows collapse to binary {0,1} due to single-vote bills.                                            |
| **M14** | `ParliamentBill.relatedVotes` shape- and data-incomplete        | Returns `ParliamentVote` (no `role`/`resolutionStatus` despite schema doc); also **drops cross-chamber votes** (senat vote twin absent). Use `voteLinks` instead.                             |
| **M15** | `caveats` field always empty                                    | 0/50, even for ambiguous bicameral-override cases. The "trust your lineage" safety mechanism does not exist.                                                                                  |
| **M16** | `ballotsTotal`/`ballotsResolved` always null                    | 65/65; combined with `BallotConnection` having no `total`, there is no upfront ballot count — batch lineage jobs must paginate every vote.                                                    |
| **M17** | Link-type NON_NULL fields undefended (latent cascade)           | `relationshipKind`/`resolutionStatus`/`role` mapped without `?? fallback` (unlike `confidenceLabel`). Clean today, but one future NULL column value cascades to nullify a whole bill dossier. |
| **M18** | REST surface + OpenAPI + `meta.asOf` unimplemented              | Design §5 specifies 20 REST endpoints under `/api/v1/parliament/` — all 404. Deliberate GraphQL+MCP-only choice, but an unannounced hard divergence; no freshness watermark is surfacable.    |

---

## 5. LOW severity & cross-check corrections

**Low severity:**

- Rejected `statusText` garbled (`respinsadefinitiv`, 73%) — diacritic/space loss.
- `parliamentActLineage(actId:"<nonexistent>")` returns `null` silently (indistinguishable from "empty"); leading-zero actIds accepted with non-canonical echo.
- Speeches are per-utterance fragments — `activityCounts.speeches` is a segment count, not a speech count (Abrudean 6252).
- MCP cohesion `query` echo drops the `group` argument.
- `parliamentGroups.chamber=""` (empty string) when invoked with no args — malformed.
- `parliamentGroupMembers` is case-sensitive (`"psd"`→0, `"PSD"`→1000).
- Senate outcome distribution is 98% `adoptat` (possible under-recorded `respins`).

**Cross-check corrections (the team validating itself):**

- **B13 RETRACTED** — an earlier claim that "the `year` filter silently excludes all senat bills" was **false**. The filter does OR over `plxYear`/`senateYear`; senat bills appear on page 11 of `year=2025`. The original 5-bill sample was misleading (senat bills sort to the tail).
- **`responseStatus` RE-CHARACTERIZED** — the 2.5–5.5% non-null values are **not** a random metadata dump; 33/33 are 100% structured and parseable (`Nr.Înregistrare | Data înregistrării | Data prezentării | Data comunicării | Termen primire răspuns | Mod adresare | Adresant`). It is **question-submission metadata mislabeled as response status** — there is no actual response-received / on-time signal. The PR-5 timeliness feed needs the `Termen primire răspuns` (deadline) field extracted properly.
- **`controlType` CORRECTED** — distinct `question`/`interpellation` DO appear (in the `split_pass` stream); the original "100% question_or_interpellation" sample was `combined_pass` only.

---

## 6. Data-quality issues (non-bug, but actionable)

- **Senate tally fields frequently null** (not zero): `nuAVotat` null in 100% of senat votes; `impotriva` null 41%, `abtinere` null 29%. Consumers cannot distinguish "0" from "missing". `pentru+impotriva+abtinere+nuAVotat == present` fails for **761/1,173 (65%)** of senat votes (treating null as 0); cdep & comun fail 0%.
- **Senate nuAVotat gap is senat-only & precisely quantified:** for senat, `present == ΣgroupBreakdown(pentru+impotriva+abtinere+nuAVotat)` in 1,169/1,169 (100%); the breakdown carries the absentee info the tally drops. cdep reconciles 1,000/1,000.
- **Ballot identity suspiciously perfect:** `matchMethod` is `exact_token_set` for 14,800/14,800 ballots; `mandateKey` null for 0/14,800 — implausibly clean over a 6-year corpus. Strongly suggests unmatched ballots are **dropped server-side** rather than surfaced for review. The 3 comun phantom+1 votes (see below) are the smoking gun.
- **3 comun phantom-+1 votes:** `cdep:30808/30809/30810` have `tally.present == ballots.count + 1` — one ballot counted in the tally is never served and attributed to no group (likely an unmatched row silently dropped).
- **4 senat stub votes:** valid `voteKey`/`voteDate` but `outcome=null`, `tally=null`, `title=""` (`senat:C3F4B62C`, `583EF996`, `423D703B`, `0E1F43CF`) — placeholder rows never back-filled.
- **`lawReference` is senat-only:** null in 100% of cdep + comun; populated in 91% of senat.
- **44 members (6.5%) have zero `groupIntervals`** despite a populated `groupName` (incl. 2 current 2024 members); 2008 cdep has no interval coverage at all.
- **Identity clustering is binary:** `confidence=medium` is never emitted (0 occurrences); `medium` enum value is unused.
- **6 same-person duplicate mandates** (original + replacement, e.g. person 621 → `{1:2024:52, 1:2024:137}`): vote totals OK (disjoint periods) but mandate-count metrics are inflated.
- **1 `normalizedName` collision:** `"alin bogdan stoica"` maps to 2 distinct personIds (2924 Stoica Alin-Bogdan / USR vs 2571 Stoica Bogdan-Alin / Minorități).
- **Older `groupName` is raw free-text:** `"ne"`, `"ales la nivel national"`, `"Prog."`, `"PD-L"` — confirms `groupName` is not a foreign key.
- **`voteLinks.role=unknown`** correlates 100% with `confidenceLabel=low` (safe fallback bucket).
- **cdep initiators are sparse:** only 29% of cdep bills have ≥1 initiator.

---

## 7. Tests PASSED ✓ (proven-solid baselines)

These checks establish what works and should not be re-litigated without reason:

- **Outcome logic:** for 4,229 votes, `outcome=adoptat` ⇔ `pentru ≥ impotriva` (0 contradictions, excluding the 4 senat null-outcome stubs). Holds even for the ×2 corrupted votes (internally consistent).
- **Per-choice ballot count == tally:** 18/18 fully-walked votes; `count(ballots.choice==X) == tally.X` for every non-null field.
- **`present == ΣgroupBreakdown`:** cdep 1,000/1,000, senat 1,169/1,169, comun 453/456 (the 3 exceptions are the phantom+1 votes).
- **Status bucketing:** 0 mis-bucketed bills across 150 (promulgated/rejected/in_progress); `finalLawNumber` presence perfectly tracks `promulgated`.
- **`actLinks linked → legalAct`:** resolves 87/87 + 40/40 (0 broken).
- **`careerTotals`:** exact match to `Σ mandates.activityCounts` (5/5 persons).
- **member ↔ person roundtrip:** 0/40 mismatches; `careerTotals.mandates == len(person.mandates)`.
- **`mandateKey` uniqueness:** 0 duplicates across 672 members.
- **Cursor pagination:** 1,280 edges walked (votes/control/ballots/members) — **0 duplicates, 0 gaps, sort respected across boundaries**; tamper resistance 4/4 rejected.
- **Filter commutativity:** 7 pairs (A∧B == B∧A, identical order + set).
- **Date-boundary inclusivity:** gte/lte/between correct at day granularity.
- **Enum exhaustiveness:** `in:[all values]` == unfiltered for all 5 enums.
- **MCP ↔ GraphQL parity:** bit-identical for all 4 tools (cohesion/lineage/resolve/member-activity).
- **Privacy:** every forbidden field (`attrs`, `birthDateParseMethod`, `clusterKey`, `fileHash`, `evidence`, `method`, `candidates`) rejected at schema validation; `personCandidates` correctly FORBIDDEN without API key.
- **Input validation:** SQL-injection strings in `q.contains` parameterized; `pageSize=999999` clamped.
- **Freshness:** no future dates (max `voteDate` 2026-06-15, `lastEventDate` 2026-06-17, `itemDate` 2026-06-16).
- **Cohesion is immune to C1:** `parliamentVoteCohesion` reads `vote_records` (ballots) directly, not `votes.tally`, so the ×2 corruption does not affect Rice-index consumers.

---

## 8. Fix priority

1. **C1 + M1** — recompute the 13 corrupted senat tallies (scrapper) and wire `tallyMismatch` so the class is detectable going forward.
2. **H2** — make the 5 list/cohesion fields nullable (or return in-band errors). Highest blast-radius server-side fix; proven pattern already in `parliamentActLineage`.
3. **Group-namespace cluster (H1, H6, H7, H9, H10, M7, M8)** — one coherent fix: reconcile party-NAME vs chamber-slug identifiers; fix the resolver, the filter, the truncation cap, the partial initiator objects, and the registry. Add resolver unit tests.
4. **Senate data-deficit cluster (H3, H5, H12, H15, M3)** — scrapper-side: extract Senate `finalLawNumber`/`finalLawYear`, relational fields, control items, declarations, and act links. Server-side: add a `(lawNumber, lawYear) → actId` resolver so senat laws become lineage-reachable.
5. **H11** — attribute interpellations to members (scrapper join key).
6. **H13, H14** — lineage correctness: re-resolve the vote's own `billKey`; surface all `linked` voteLinks (or document the role filter).
7. **Dead fields (M1, M15, M16, M5, M10)** — either wire (`committee`, `caveats`, `ballotsTotal/Resolved`, `declarationDate`) or remove from the SDL.
8. **H8** — validate `pageSize`/`first` bounds (reject or clamp with an explicit signal); enforce the cap uniformly (incl. `vote.ballots`).

---

## Appendix A — Bug register (compact)

| ID     | Sev      | Title                                       | Area            | Origin          |
| ------ | -------- | ------------------------------------------- | --------------- | --------------- |
| C1     | CRITICAL | Senate tally ×2 (13 votes, 2 days)          | votes           | scrapper        |
| H1     | HIGH     | `group` resolver null (100%) — 2 defects    | members/groups  | server          |
| H2     | HIGH     | Non-null error propagation nukes queries    | contract        | server          |
| H3     | HIGH     | Senate bills are relational stubs           | bills           | scrapper        |
| H4     | HIGH     | `hasLaw` ≠ `finalLawNumber` (218)           | bills/filters   | server+scrapper |
| H5     | HIGH     | 1,575 laws null `finalLawNumber`            | bills           | scrapper        |
| H6     | HIGH     | `group` filter drops slug form              | members/filters | server          |
| H7     | HIGH     | `members.group/judet.in:[]` = no-filter     | members/filters | server          |
| H8     | HIGH/MED | `pageSize`/`first` invalid silently coerced | pagination      | server          |
| H9     | HIGH     | `groupMembers` truncates at 1000            | members/groups  | server          |
| H10    | HIGH     | `bill.initiators` partial objects           | members/bills   | server          |
| H11    | HIGH     | Interpellations lose member/author          | control         | scrapper/server |
| H12    | HIGH     | Senat: zero control items + declarations    | control/decl    | scrapper        |
| H13    | HIGH     | Lineage misreports senat vote `billKey`     | lineage         | server          |
| H14    | HIGH     | Lineage drops 19% of voteLinks              | lineage         | server          |
| H15    | HIGH     | Senate laws unreachable from lineage        | lineage         | scrapper/server |
| M1–M18 | MED      | see §4                                      | various         | mixed           |
| L-\*   | LOW      | see §5                                      | various         | mixed           |

## Appendix B — Reproducibility

All raw evidence (specialist reports + query files + JSON outputs) is retained in the audit workspace outside the repo. Key reproduction snippets are inline in each bug entry above. The GraphQL endpoint and helper conventions are documented in the audit's `SCHEMA.md` reference (field names verified via introspection — note that several field names differ from the design doc, e.g. `ParliamentGroup.name` not `groupName`).
