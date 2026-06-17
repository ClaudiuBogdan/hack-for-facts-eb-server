# PNRR module — interface decisions (pilot)

Binding plan: `docs/server-redesign/07-pnrr.md`. Built on the shared kernel
(`src/modules/shared`). Surface = **GraphQL + MCP only** (REST deferred).

Interface reviewed by Codex (gpt-5.5 xhigh) + GLM-5.1 (high) in parallel
(2026-06-17). Convergent findings; resolutions below.

## Kernel gaps surfaced (for the GM / other 9 modules)

- The plan referenced `ResolveHit` and `Conn<T>` as "kernel-owned shared types".
  **Neither exists in the kernel.** The kernel ships `CursorPage<T>` (used
  everywhere here) and has no resolve type. This module defines a module-local
  `PnrrResolveHit`. **Recommendation:** the kernel should hoist a shared
  `ResolveHit` (un-prefixed) so discovery/resolve is uniform across modules —
  otherwise each of the 10 modules invents its own `*ResolveHit`.

## Decisions (review findings → resolution)

| # | Finding (Codex/GLM) | Resolution |
|---|---|---|
| P0 | `PnrrEntityProfile.entity` + `PnrrEntity.profile` = circular, two paths | **Removed `entity` from `PnrrEntityProfile`**; profile is a projection of facts about a known CUI. `PnrrEntity.profile` remains (lazy, calls the SAME `getPnrrEntityProfile`). |
| P0 | `Entity.pnrr` must go through `profileSlice`; rich type vs open `EntityProfileSlice` | Usecase `getPnrrEntityProfile` returns the rich `PnrrEntityProfile` (single source of truth). Contributor `profileSlice` wraps it: `{ source:'pnrr', kind:'entity_profile', summary, data: profile }`. `Entity.pnrr` resolver calls `profileSlice` and returns `data` (typed projection). One code path. |
| P0 | `PnrrCommitment.progress` / `PnrrAcquisition.contractors` cardinality footgun on list pages | `PnrrCommitment` carries `progressCount` + `latestProgress` only; full series ONLY via `pnrrCommitmentProgress(commitmentKey)`. `PnrrAcquisition.contractors` kept (bounded small child, avg ~1/acquisition) but `PnrrAcquisitionDetail` is the rich drill-down. |
| P0 | `PnrrSource` sub-object duplicates kernel provenance | Dropped `PnrrSource`. Row-level freshness is a nullable `retrievedAt: DateTime` directly on facts. Cross-source provenance stays the kernel's `SourcePresence.asOf`. |
| P0 | acquisition `beneficiaryCui` mislabeled (Codex/GLM said rename → applicant) | **Challenged + kept `beneficiaryCui`.** Verified live: `acquisitions.beneficiary_cui == announcement.applicant_cui` 100%. This entity is the **PNRR beneficiary** (grant recipient) running the procurement; on the announcement it is the *applicant*. Keeping `beneficiaryCui` preserves cross-collection consistency (payments/commitments/acquisitions all key on the PNRR money recipient) — the more valuable entity-360 property. Documented in the SDL description. |
| P1 | rank `by:String` → enum | `enum PnrrContractorRankBy { value awards }` (lowercase, mirrors repo union). |
| P1 | `pnrrResolve(dim:String)` → enum | `enum PnrrResolveDim { entity component measure county contractor }`. |
| P1 | money range filters typed `number` → GraphQL `Float` violates no-float money | **Dropped money-range filter fields** (`minAmountLei`/`maxTotalValue`/…) from v1 specs. The kernel has no money/decimal filter type; a `Float` range over `numeric(18,2)` is precision-unsafe. Documented deferral; add when the kernel ships a decimal filter op. Amount **sorting** stays (repo-side, not a filter value). |
| P1 | `PnrrContractorRankRow.role` ambiguous after group-by | Replaced single `role` with `roles: [PnrrContractorRole!]!` (distinct roles in the aggregated set). |
| P1 | `status` should be an enum | **Not feasible:** live `commitments.status` values are Romanian free-text with spaces/diacritics/parens (`ÎN IMPLEMENTARE (sub 30%)`) — illegal GraphQL enum idents. Kept `status: String!`; the filter spec's `enumValues` constrains inputs to the live set (the filter `enum` type is a string-union validator, not a GraphQL enum). |
| P1 | `hubs:[String!]` → enum | Kept `[String!]!` for forward-compat (a CUI may link to registries added later); filter `hub` is an `enum` validator over the live set. Documented. |
| P1 | filter specs missing `alias` | Every `FilterColumn` carries the repo's table alias (`p` payments, `c` commitments, `a` acquisitions, `ct` contractors, `e` entities, `m` measures). |
| P2 | `PnrrPaymentAggRow` add label | Added `label: String` (resolved component/measure/county name where cheap). |
| P2 | snapshot `linkConfidence` vs contractor `confidence` naming | Kept (different semantics, both documented); not worth a rename churn. |

## Grain gate (§14.6)

- Cross-source / entity-360 flow totals → kernel `FlowsRepo` over `flows.money_flows`.
- PNRR-native facts (payment totals, by-component/measure/county, contractor
  rank, commitment progress) → this module's repo over `pnrr.*`.
- **Never sum across `flow_type`.** `PnrrEntityProfile` keeps payments /
  commitments / procurement in separate sub-objects + a `grainNote`. Contractor
  rank excludes self-awards (loader gate = 0 self-loops).

## PII / exclusion (§8.2 — hard)

- No repo method selects `pnrr.announcement_contacts_private`.
- `is_personal_recipient` (payments + announcements) never projected (internal gate).
- `attrs jsonb` never projected wholesale — named columns only.
- Omitted internal columns: `*_raw` (`status_raw`, `county_id_raw`), provenance
  (`raw_item_id`, `source_record_hash`, `transform_version`, `source_table`,
  `source_pk`, `run_id`). `source_system`/`retrieved_at` ARE surfaced (freshness).
- `measure_raw` IS surfaced (human-readable measure label, not internal provenance).

## Index-bound rule (§3/§7)

List/aggregate methods reject a filter set with no indexed driving predicate
(`InvalidInput`), except `aggregatePayments` over a bounded `paymentDate` window.
`commitment_snapshots` (741k) is ALWAYS bounded by `commitment_key` or
`(beneficiary_cui, contract_number)`. `getCommitmentProgress` resolves the key →
`(beneficiary_cui, contract_number)` so unlinked snapshots stay reachable.

## Verified golden numbers (live, 2026-06-17)

CNAIR cui `16054368`: 1,229 payments = 6,210,010,594.17 lei / 1,256,053,436.75 eur,
all component C4, first 2022-09-29 last 2026-05-11; 32 commitments; 0 acquisitions
as beneficiary; 0 contractor wins; role = beneficiary only.
`hasNoHub` residual = **1,435** (= 18,876 − 17,442 distinct-cui links). Flows
source_id=pnrr: payment 73,333 / commitment 24,078 / subcontract 14,796 = 112,207.
Search docs pnrr_*: 71,679.

## Implementation review (Codex gpt-5.5 xhigh + GLM-5.1, 2026-06-17)

Adversarial review of the implementation. Both ran in parallel; convergent
findings. No P0 SQL-injection / money-precision / grain bugs (verified clean).
Fixes applied:

| Finding (both unless noted) | Resolution |
|---|---|
| **NULL-date keyset cursor loses/misplaces rows** (Codex P1, GLM P0). payments/commitments/acquisitions cursor predicates didn't handle `DESC NULLS LAST` NULL dates → null-dated rows unreachable or duplicated. | Added `descNullsLastCursor()` helper (the pattern the contractors cursor already used) and applied to all three; null date encoded as `''` sentinel in the cursor keys. |
| **`rankContractors` claimed self-award exclusion but didn't** (both). 85 self-award rows (contractor == acquisition beneficiary) were counted. | Added `NOT EXISTS` self-award exclusion (grain-preserving) so the SQL matches the loader's `pnrr_subcontract` gate (=0 self-loops) and the advertised caveat. (Verified: 0 multi-role/dup rows per acquisition, so no double-counting.) |
| **Empty `in: []` bypassed the driving-predicate guard** (Codex P1) → unbounded scan. | `hasField` now treats empty `in: []` / `between: {}` as NO predicate, so the index-bound guard rejects them. |
| **Virtual filters (role/hub/hasNoHub/year) silently no-op on bad input** (Codex P1). | `validateVirtualFilters()` returns `InvalidInput` for bad enum/bool/year; called in entities + payments + aggregate. `year` bounded 2000–2100 (fixes GLM P2 invalid-date 500). |
| **CUI normalization parity** (GLM P1-3): `Entity.pnrr` normalized (kernel), but `pnrrEntity`/`pnrrEntityProfile` didn't → `RO16054368` broke §14.7 parity. | Normalize CUI at the **repo boundary** (`getEntity`/`getEntityProfile`) so ALL surfaces (GraphQL, MCP, contributor) are consistent — the single source of truth. |
| **`is_personal_recipient` rows not row-gated** (Codex P1), only the flag hidden. | Added defense-in-depth `is_personal_recipient IS DISTINCT FROM TRUE` to payment list/aggregate/profile (0 live rows, but future-proof). |

Deliberately NOT changed (challenged a reviewer):
- **`listEntities` / `rankContractors` driving predicate** (GLM P1-1/P1-2): the
  directory is intentionally browsable unfiltered (cursor on the PK `cui`, an
  index-ordered scan) and the global contractor rank (PN-4) is a bounded
  ≤100 group-by over a 15k-row table. Forcing a predicate would break those
  golden cases. Kept open; documented.
- **`measureRaw` projection** (GLM P2): kept — it is the human-readable measure
  label (source content), not internal `*_raw` provenance. ETL rename suggested
  as a future cleanup.

Kernel finding for the GM (validates the pilot for the other 9 modules): the
stateless-MCP HTTP transport schedules a delayed `forceClose` that throws
`socket.destroySoon is not a function` post-response (a teardown race — task #22).
Harmless to requests; the integration test swallows only that exact error.
