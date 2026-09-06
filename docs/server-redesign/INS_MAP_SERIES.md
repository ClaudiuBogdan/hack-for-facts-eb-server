# Native INS map series

The latest-map reader is an internal building block; it is not yet mounted on
public map routes. Its caller supplies one resolved dataset, complete exact
non-geographic pins, one unit, one frequency and unique modern territory IDs.
Preparation and reads must share the operation's `InsReadSession` repository.

## Period decisions

User decisions, 2026-09-06:

- Latest available uses one common reference period. Older observations never
  fill missing territories.
- A selected interval requires an explicit sum, average or latest-observation
  operation. This must remain separate from legacy classification aggregation.
  Interval implementation is pending.

`readLatestMapSeries` preserves full-history geographic ambiguity before choosing
among the newest two observations per territory. The reference is latest among
uniquely resolved eligible series, including null-valued observations. Missing
periods, no observations, ambiguous geography and source-null values remain
separate outcomes. Source-time duplicates and inconsistent period IDs/dates fail
the operation. Values remain decimal strings; no arithmetic or numeric coercion
occurs in this reader.

## Bounded reads

The native repository retains its existing 40-request candidate/winner SQL and
all eligibility predicates. Hydration is deferred up to the previously supported
maximum batch size, 40 × 1,001 = 40,040 rows, then flushed without truncation.
Late hydration failures reject the complete operation.

INS snapshots set JIT off locally. A measured 40-territory POP107D candidate read
spent 414 of 429 ms compiling JIT code. No global database settings or deadlines
changed. This and deferred hydration allowed the complete local UAT request to
finish in 21.8 seconds under the existing 30-second operation deadline; county
reads took 1.7 seconds. Revalidate performance on additional datasets.

A same-snapshot comparison of committed versus optimized hydration produced
identical output hashes for all 3,180 resolved UAT series. Six sector geometries
lack native INS nodes and must remain unavailable. This is reader parity, not an
independent validation of INS population values or eligibility as a budget factor.

Evidence is tracked in the sibling scrapper repository at
`prod-db/evidence/advanced-map-2026-09-06/native-ins-map-latest.json`.
