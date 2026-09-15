# Annual population in maps — 2026-09-15

## Approved scope

Use the published `core.population_annual` cells already used by financial per-capita calculations. No database migration, reseeding, changed population measure, or changed financial normalization formula. Server/client changes target `dev`.

- `mapAnnualPopulation(year, granularity)` batches one complete map level. It reads identity and population in one read-only snapshot through the existing annual population port.
- UAT keys are SIRUTA; County keys are existing map mnemonics. UAT output includes the six Bucharest sectors and excludes Bucharest municipality. County output uses the canonical county population cell, never the sum of city plus sectors.
- Missing or unpublished cells stay null. Carry-forward source year, age and provenance are returned from the curated table. Duplicate/malformed territory keys fail structurally.
- Execution and commitments population bounds use the latest selected year's annual population. They retain the existing institution-territory filtering meaning. They do not reinterpret a county view as a new county-total population filter.
- No changes to financial amount filters, per-year per-capita arithmetic, or financial period availability.

## Verification

- Astra high reviewed the design before implementation and identified two client corrections before commit: ignore unused disabled population series; align runtime population year with the effective budget period. Both were corrected and regression-tested.
- PostgreSQL: 97/97 budget integration tests pass, plus a separate passing commitments annual-bounds regression, running actual generated SQL and real migration DDL on a disposable Zeus database. Annual table DDL was pinned from scrapper commit `337fee09`, SHA-256 `022825d5b629df5bff3a417660b8454fa83ac095361738d9e4c462f4a3af05c4`. A concurrent scrapper checkout change required the stable committed DDL archive, not a schema mock.
- Counterfactual fixture deliberately sets static territory population to 1 while annual population differs by year: filters follow annual values, financial rows stay identical, missing/failed publications do not qualify.
- Full server suite: 5,357 passed, 227 skipped. Typecheck, lint, dependency boundaries and build passed.
- Read-only local GraphQL over Chronos: 3,186 UATs and 42 counties. Sector 1 in 2025 returns 264,698, source year 2025, carry age 0. Bucharest County returns 2,124,150. UAT output excludes municipality 179132.
- Evidence: `/private/tmp/map-population-implementation-20260915/` (local, not a portable artifact).

## Security review and bounded follow-ups

GLM 5.3 max was a lower-trust, read-only security reviewer. Its suggestions are advisory, independently checked before any change.

The new query exposes public territory population only, uses parameterized SQL, applies publication eligibility, and returns a sanitized failure. Client requests use no bearer token and validate the response, including safe integer values, year consistency and unique map keys. Source URLs are constrained to HTTP(S) by the existing client population schema and are not rendered by this map addition.

Deferred existing concerns from GLM: owner-dataset cache isolation on account changes, grouped-series auth hydration timing, URL-state size bounds and 32-bit cache hashing. These are separate from the public annual population path and require focused reproduction before proposing a broader change. No new identity/auth/cache protocol is introduced here. Suggested annual-year argument validation is already enforced by the saved configuration schema and server boundary. Suggested year-spread overflow is bounded by distinct valid years, not raw request length. Existing map privacy behavior is unchanged; raw repository rows are not response payloads.

## Release order

Deploy server first (additive query and changed population filters), then the client. Verify the batch query, population year switching and an existing census map. No Chronos data update is required. This note records implementation validation, not a deployment claim.

Final Astra delta review: GO for the scoped map changes; no remaining release blocker identified. Private dataset access was also checked: server owner queries constrain `user_id`, so GLM did not demonstrate an IDOR.

Live filter proof: Sector 1 2025 at minimum population 250,000 and 260,000 returns the same 1,512,813,320.2 RON; minimum 270,000 excludes it. Local batch timings: UAT 1.55 seconds, County 0.34 seconds (single measurements, not a benchmark).
