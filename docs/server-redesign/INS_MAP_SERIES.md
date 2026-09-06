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
  `readIntervalMapSeries` implements this choice for resolved selections.

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

## Interval reduction

Intervals accept 1–1,000 unique canonical year, quarter or month tokens of one
frequency, including noncontiguous selections. Sum and average require exactly
one non-null observation for every selected period in each territory. Missing or
source-null periods produce an explicit incomplete cell, never a partial total.
Alternative source geographies remain ambiguous; duplicate or overlap-only time
identities fail the operation. Latest within an interval uses the same shared-date
rule as latest available.

Sums use exact decimal arithmetic. Recurring averages round to 40 significant
decimal digits, half-up. Values never pass through JavaScript numbers. Units are
fixed by selection; mixed currency regimes and unknown monetary currencies reject
reductions. Raw latest observations retain their original currency metadata.

History reads request one overflow witness and bound hydration to 40,040 rows,
reducing each chunk before proceeding in the same read session. No timeout or
partial-success fallback was added. A full POP107D 2025–2026 sum took 1.7 seconds
for 42 counties and 25.4 seconds for 3,180 resolved UATs on the local read path.
Longer histories may reach the existing deadline and return an error.

## Public source selection

`readInsMapData` is the module's map adapter entry point. It encloses preparation
and fact reading in one snapshot; the application supplies its operation
`InsReadSession` repository to retain the existing deadline. The caller supplies
presentation keys from the native public territory lookup.

Exact dimension/member pairs override only their own non-geographic axis.
Certified defaults fill remaining axes; missing policies require selection.
Source geographic pins are rejected for map-wide series. A selected source unit
must belong to the dataset; display labels never select or convert a unit.
Datasets with several published frequencies require an explicit frequency.
Unknown geometry nodes remain a separate list of gaps. County keys resolve only
to NUTS3, UAT keys only to LAU. No city observation fills a sector gap.

The shared default builder retains the legacy preference wrapper, so existing
entity and chart defaults retain their behavior. Grouped-map input adapters must
reject ambiguous legacy labels/multiple members and must not infer the new
interval operation from the old `aggregation` property.

SQL statement batching also respects PostgreSQL's 65,535 bind-parameter limit.
Long range selections reduce the number of territory branches per statement;
ordinary short selections retain 40. The complete 1,000-period selection was
verified on actual migration DDL for sum, average and latest, including both
candidate and winner queries with 40 requested territories. Hydration limits and
query predicates are unchanged.
