# Factor set 1 reference fixture

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
