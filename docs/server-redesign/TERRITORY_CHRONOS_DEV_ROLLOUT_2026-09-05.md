# Territory prerequisite for the Chronos dev migration

Status: S1a implemented and reviewed locally. SQL regression 22/22; full server
gates pass (5,316 tests). No territory L2 apply.
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

## S1b remains required before L2

Expose native territory metadata and isTerritorialExecutive through server/client
selection and responses. Replace the remaining legacy UAT-level population
proxy before L2 so the new 403 node cannot be mistaken for a sector. Keep
county-heatmap fiscal representative selection separate from geographic nodes. Preserve explicit persisted is_uat selections; migrate
app-owned defaults to executive-only selection. Executive-only SQL must request
the entity join. Population planning must preserve both executive/is_uat predicates
and handle county-only selections. County councils must retain per-capita UI gates.
The two procurement-repo legacy SIRUTA joins also require migration before L2.
The current heatmap representative selector intentionally returns PMB, not the
future 403 geographic node (whose uat_code is null); S1b must replace the county
identifier proxy with an explicit executive lookup while preserving PMB.
No L2 flag flip before that complete server/client path is tested and deployed.

Annual POP107D native normalization, geographic-union sums, INS coordinate handling,
release control and the remaining missing client/API roots remain later milestones;
S1a does not claim those capabilities.

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
