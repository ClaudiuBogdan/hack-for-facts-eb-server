# Native grouped budget analytics

Design approved by Astra high and Fable high, 2026-09-05. Final Astra high, Fable high and GLM 5.3 code/security reviews approved this bounded dev slice. Scope: `entityAnalytics` and `aggregatedLineItems` on the Chronos native endpoint, server/client dev only. No writes to the serving database from the server.

## Identity and coverage

Independent live anti-joins found 139 fact CUIs (34,650 execution rows) absent from the current public-entity registry. All already have checksum-valid organization-spine records, public privacy, and source reports. None has execution after 2024. `CORE_ENTITIES.md` defines the organization spine as identity and the public-entity registry as optional evidence. Keep those nominal facts; do not fabricate public-entity records or silently drop their money.

For entity output, join both organization and registry evidence. Apply shared identifier-length and declared-public organization predicates before search, sorting, counting and paging. An absent organization is distinguishable from a present restricted or NULL-privacy organization. Never hide restricted organizations in a LEFT JOIN condition and then expose their name/CUI through a fallback. Display precedence is public-entity name, authorized organization name, original fact CUI. Classification money aggregates do not expose entity identity and do not inherit that identity-output restriction.

Eligibility is three-state: known executive, known nonexecutive, unknown. Only known executives receive entity per-capita metrics; ordinary institutions do not inherit headquarters population. Unknown eligibility and missing eligible population make a required per-capita ranking unavailable before paging. Nominal auxiliary per-capita values are nullable. Explicit executive/type/geography predicates may legitimately narrow the admitted population; absent registry evidence must never become `executive:false`. Fact-side coverage must prevent a mixed known/orphan request from dividing all money by only known population.

Measured preflight: all 3,228 current executives have canonical anchors and positive populations. This proves the current snapshot only, not annual INS custody or coverage. Detailed evidence is in the scrapper repository under `prod-db/evidence/native-grouped-analytics-2026-09-05/`.

## Query shape

Reuse the cleaned legacy filter, report/period pruning, shared entity/geography predicates, funding-ID mapping, and amount/period flags. Aggregate filtered facts by group and year after exact month/quarter selection. Apply Decimal-generated numeric year multipliers in SQL, then group across years, apply thresholds to the selected primary value, sort deterministically, and page. Obtain the independent total count even for limit zero or an out-of-range offset. No capped executionAnalytics intermediate and no in-memory reimplementation of SQL sorting.

Entity grouping uses the original fact CUI. Classification grouping retains unknown codes and takes deterministic denormalized names from the facts; a catalog join must not remove observations. Stable ties use CUI or the classification code pair, with NULLS LAST in both directions. Counts describe matched fact rows. Omitted report type expands to all three supported execution report types, preserving pruning and the carried contract.

Strict monetary normalization requires exact-year positive CPI/FX/GDP. Missing factors are unavailable, never carry-forward or nominal fallback. GDP percentage remains exclusive. Normalize each year before summing. The existing legacy series fallback policy is not copied into new code and must converge to the strict policy before final migration acceptance. Annual territory population must replace the S1b snapshot before full goal acceptance; its seam is being checked against the existing factor-set schema.

## Contract changes to record and test

- Nullable auxiliary `per_capita_amount`, with blank CSV cells and explicit unavailable display.
- Per-capita eligibility and global coverage checks before paging; no partial ranking.
- Preserve valid historical organization identities without current registry membership.
- Preserve unknown classification codes and deterministic fact labels.
- `AMOUNT` sorting and aggregate bounds use the selected primary value.
- Honest total count on empty pages.
- Strict exact-year monetary factor coverage.
- Carry the missing `SortOrder` input into the native schema.
- Invalid sort fields return InvalidInput rather than silently changing sort. Negative pagination is rejected instead of clamped to zero.
- Database failures use a static message without SQL details. Missing functional labels fall back to the original code. SDL descriptions clarify yearly ratios without changing wire fields.
- Keep the implemented 100,000 maximum, log clamps, fix client requests for 150,000.
- Aggregate roots continue to ignore period-growth display, explicitly documented.

Validation must use actual generated SQL on PostgreSQL built from the pinned real migrations: multi-year rank reversal, every filter and exclusion, sparse periods, unknown and restricted identities, unknown classifications, off-page coverage failures, nulls-last, deterministic ties, limit zero, out-of-range pages, report-type pruning and exact independent totals. Client transport and nullable consumers require browser tests. Complete Astra high, Fable high and GLM 5.3 security reviews before commit.

## Implementation decisions and remaining gates

Native grouped classification scopes use the checked union even when callers only supply old filter fields. Explicit geographic selections retain geographic denominator priority unless CUIs are supplied: a county plus an entity-name search still uses the full selected county population. Distinct requested territory IDs and county codes are left-joined from VALUES so missing selections cannot disappear. Each key must match exactly one anchor; ambiguous county codes are unavailable, while duplicate input keys are harmless. The shared union checks topology before retaining maximal ancestors, and positive population only on retained nodes. Covered children do not need separate population; missing selected ancestors cannot fall back to children. Carried execution-series scope selection is unchanged.

The server now keeps GDP percentage exclusive in both primary and auxiliary output: auxiliary per-capita is null and incompatible per-capita sorting returns InvalidInput before dependency reads. Shared identity `getIdentifiers` checks both the organization's and each identifier's declared-public privacy class. These are independent gates; a public organization does not authorize every identifier attached to it.

The shared budget name/CUI search now also applies to the carried executionAnalytics numerator and its entity-union denominator. It searches the displayed public-entity/authorized organization/CUI expression, with escaped LIKE input. Search is also an identity lookup: the entire name/CUI predicate requires a servable identifier and an absent-or-declared-public organization, including the display-name CUI fallback. Restricted and NULL-privacy rows cannot be probed through search on monetary aggregate roots. This is an explicit privacy tightening alongside the search broadening; unsearched classification totals retain their money. Existing explicit CUI/creditor include/exclude lookup policy remains a separate containment follow-up before final acceptance.

Population remains transitional: entity SQL consumes a territory/year relation whose only shipped adapter broadcasts the S1b snapshot. An injected two-year fixture proves division-before-sum and missing-year rejection. Classification currently loads one checked scope scalar and broadcasts it. Neither proves annual custody, matching national/scoped concepts, immutable projected vintage, or a release-consistent snapshot across separate reads. Those remain mandatory before final migration acceptance; no annual adapter is selectable yet.

Live read-only probes of the generated default 2025 principal-aggregate expense SQL returned 3,296 entity groups in 397 ms and 9,016 classification groups in 318 ms (five-row pages, full counts). These are performance observations, not a deployed-root acceptance claim or independent data-parity proof.

Do not add broad parity allowlist entries to hide changed errors, eligibility, order or totals. The current golden-master classifier cannot allowlist arbitrary contract breaks; record measured case-specific data drift there and keep the dedicated grouped SDL/semantic regressions as the explicit approved contract. Full corpus replay remains required before deleting legacy modules or enforcing final cutover. The catalog allowlist still contains pre-T103000 counts and requires a measured refresh during that replay.

## Final local validation

Typecheck, lint, dependency boundaries and production build passed. Full bounded-worker suite: 5,335 passed, 227 existing skips. The first run hit one unrelated five-second cold-bootstrap timeout; the focused seven-test rerun and full two-worker run passed without a test or timeout change. Actual PostgreSQL suite: 44 passed against nine content-pinned real migrations. Client: 7,552 tests, 77 affected browser tests (two existing browser skips), production build and 1,466 built JavaScript checks passed. Independent Chronos SQL agrees on 991,058,907,047.27 RON / 356,632 facts for both roots. Deployment remains a separate gate.
