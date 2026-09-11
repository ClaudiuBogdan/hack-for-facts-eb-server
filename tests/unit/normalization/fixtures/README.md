# Factor set reference fixtures

## Factor set 1 (`factor-set-1.json`)

`factor-set-1.json` is the complete small public normalization snapshot read from
Chronos `transparenta_prod` on 2026-09-04, in a bounded read-only transaction.
No private fields or credentials are included. No production data was changed.

Identity: set `1`, manifest digest
`69cc0473af19ffb406fe9f2ed3f82c7785a3aa4ea6df74dfd360220c92e41078`.
Rows: 228 total; CPI level 54, CPI YoY 54, inflation 54, EUR 21, USD 21, GDP 15,
population 9. All rows have YEAR frequency. Values are numeric text at 12 decimals.

The unit test compares the five API-consumed series against the independently
loaded server YAML, including its exact-rational CPI chain-link implementation.
This proves adapter equivalence, not publisher correctness or promotion eligibility.

The SQL test seeds these public values directly with labelled fixture metadata
solely to test the reader. It does not exercise or bypass production custody: no
production loader is invoked. The database must be empty and explicitly named
`budget_phase_a*` on localhost. Actual migration DDL is imported from the scrapper
and checked against pinned SHA-256 hashes; no serving-table DDL is invented here.

## Factor set 2 (`factor-set-2.json`)

`factor-set-2.json` is the complete promoted normalization snapshot read from
Chronos `transparenta_prod` on 2026-09-11 in a bounded read-only statement, in
the same shape as set 1. No private fields or credentials are included. No
production data was changed.

Identity: set `2`, manifest digest
`5f2948ec1c350530b43d38b76dbad34bdf3251c9d451d255a41ca015067c3195`, promoted
2026-09-08 (run 23230). It is the set the kernel build pins
(`NATIVE_FACTOR_SET_ID` / `NATIVE_FACTOR_SET_DIGEST`). Rows: 261 total; CPI level
55, CPI YoY 55, inflation 55, EUR 21, USD 21, GDP 31, population 23. All rows have
YEAR frequency. Values are numeric text at 12 decimals.

`tests/unit/budget/embedded-factor-table.test.ts` pins the budget module's embedded
compatibility factor table (`shell/repo/analytics.ts`, composed by no server at
this revision — see its header) to
the EUR and GDP rows of this fixture, value by value and year by year, and
asserts the compatibility multipliers equal the native derivation. The test also
pins a SHA-256 over the fixture rows, so an edit to this file after the read is
caught. The `digest` field is self-declared: replacing the promoted set in
Chronos changes nothing locally until `NATIVE_FACTOR_SET_DIGEST` moves in code,
which is when the test's digest pin fails and the set must be re-read (same
statement, `factor_set_id = 2`). Fixture-to-database parity is only checkable
live; it was checked on 2026-09-11.
