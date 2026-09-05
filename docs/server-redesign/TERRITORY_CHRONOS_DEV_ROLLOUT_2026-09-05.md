# Territory prerequisite for the Chronos dev migration

Status: S1a committed and deployed on Chronos dev (code 62afcb92, image pin
77551935); both replicas healthy. SQL regression 22/22; full server gates passed
(5,316 tests). S1b implemented locally and approved by Astra high, Fable high and GLM 5.3.
Server type/lint/dependency/build gates passed; 5,320 tests and 29 PG18 tests passed.
Client production-build dependency reconciliation is in progress.
No territory L2 apply.
User approval is recorded in the scrapper full-migration authorization of Sept 5.
Only server/client dev branches and Chronos dev deployments are in scope.

## S1a: canonical anchors and geographic reads

Every public-entity-to-territory join in the kernel filter, reference and budget
repositories uses public_entities.territory_id -> territories.id. Legacy SIRUTA
remains an optional identifier, not a fallback join. Detail and lazy reference
resolution use the same CUI lookup; withheld identities remain blocked and lookup
errors remain errors. Live preflight: all 15,056 entities resolve identically by
the old and new joins; zero anchor disagreements or newly missing anchors.

County reads select native county nodes. Until Bucharest's county node exists,
its municipality is the explicit compatibility row. The county node's existence,
not a non-null population, removes that fallback. County-set normalization is
unavailable if any requested county or denominator is missing; it cannot silently
normalize against a partial population sum. The usecase rejects missing, non-finite
or nonpositive population for both country and scoped normalization; no nominal
values are returned with a per-capita label.

UAT browsing/search includes level=uat plus the six locality/sector nodes. The
predicate runs before search's limit. Reference county/region uatCount reports
actual geographic UAT nodes, excluding county nodes and sector localities; the
presentation list can contain sectors without changing that geographic count.
County population comes once from the selected county node, not from summing its
children and itself. Fiscal parent1/parent2/main-creditor relationships are unchanged.

Regression SQL runs on an isolated PostgreSQL database on Zeus from content-pinned
real scrapper migrations, including T100000; migration execution is transactional.
Tests deliberately distinguish PMB and county populations, preserve missing county
population, use absent/conflicting legacy SIRUTA beside a valid FK, and keep the
existing explicit-CUI overlap behavior visible. Unit tests cover reference list
resolution by CUI, error propagation and same-tick duplicate requests.

## S1b: native metadata and executive selection

Territory responses expose nullable level, kind, territoryKey, parentId and nutsCode.
Public entities expose isTerritorialExecutive independently from isUat. Native
budget/reference filters and the carried analytics filter preserve explicit true
and false. Native per-capita entity ranking uses executive eligibility and the
canonical anchored population; county councils retain client eligibility when
isUat becomes false. Older DTOs fall back to isUat only when the executive field is
absent, never when explicitly false or null.

New carried requests that include is_territorial_executive opt into the population
union of their selected administrative anchors. The numerator and denominator share
entity/geography predicates, including both flags and their intersections, names,
tags, types, population bounds and exclusions. Fact-only period, report, creditor,
classification and amount predicates apply only to the numerator. Explicit
geographic scope retains the carried API priority. Requests without the new field
retain their existing denominator behavior, including explicit-CUI overlap.

The union retains selected ancestors once, without counting their selected children
again. Parent traversal is in one SQL statement and checks missing anchors, dangling
parents, cycles and missing/nonpositive retained populations. A known selected
ancestor can cover a child with missing population; a missing ancestor population
cannot be replaced with child populations. L1 county roots are accepted only while
no country node exists. Unparented PMB is accepted only while both country and
Bucharest county are absent. This is administrative anchor coverage, not an estimate
of institutions' service areas, and currently uses the existing population snapshot.
Annual POP107D factors remain a separate prerequisite for final acceptance.

County map fiscal representatives resolve explicitly through executive anchors.
Bucharest remains PMB by its stable municipality identity, independent of geographic
403 or creditor parent relationships. Ambiguous executive matches return null.
Procurement's two geography joins use canonical territory_id. Legacy SIRUTA discovery
excludes unanchored and nonlocal geographic nodes before limiting name matches.

## Remaining prerequisites before L2

Mount and test the native advanced-map provider/routes, carry the executive filter
through all remaining legacy allowlists (advanced-map, MCP, notifications and report
loaders), and then migrate app-owned map defaults to executive selection. Existing
persisted is_uat selections must remain unchanged. These paths are not claimed by
this S1b slice. No L2 flag flip before the complete path is tested and deployed.

Annual POP107D normalization, INS coordinate handling, release control and the
remaining missing client/API roots remain later milestones. The complete migration
is not done until their live page acceptance gates pass.

## Reviewed acceptance evidence

Astra high and Fable high approved S1a after fixing the downstream missing-population
fallback. Fable retracted its suggestion to substitute the geographic county node
for the fiscal heatmap representative after checking the original 403 design.
GLM 5.3 security review covers the final changes before commit.

Independent live SQL accounts for all 42 county deltas: populations were doubled
by summing county and child rows (38,107,630 becomes 19,053,815); actual UATs are
3,181 rather than 3,228 (exclude 41 county nodes and six sectors from this count).
This uses the existing population snapshot, not the later annual INS authority.
Regional county counts remain unchanged. Exact per-county and region snapshots,
review dispositions and deployment checks are retained in the scrapper's
`prod-db/evidence/territory-s1a-2026-09-05/`.
