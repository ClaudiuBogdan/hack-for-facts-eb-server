# Entity analytics performance — 2026-09-14

The default entity ranking used a full aggregation to find population anchors,
then discarded the ranked page and repeated the same aggregation. The native
population-independent path now retains its first page, global count and global
coverage verdict, then enriches only those CUIs using the existing SQL formulas.
Only population and per-capita fields are merged back. Population-dependent sorts
and bounds retain full-anchor discovery. Array binding avoids a parameter-count
limit for large pages; privacy and all original filters remain in both reads.

An additive scrapper migration, `20260914T090000__ins_geo_territory_lookup`, indexes
INS geography by `(dataset_code, territory_id)`. Its hash is pinned in the real
INS fixture. Source tuples remain nonunique by territory so ambiguity detection
is unchanged. This migration is not executed by the server.

## Verification

- Astra xhigh review approved; GLM 5.3 max security review found no SQL/privacy
  issue. Its conditional SSR cache observation was addressed in the client with
  explicit Cookie variation (Nitro already varies on cookies).
- Server type/lint/dependency checks and build passed; 5,344 unit/integration
  tests passed (227 intentionally skipped by the existing suite configuration).
- 94 real PostgreSQL budget tests passed, including annual normalization, global
  coverage before pagination/bounds, empty pages, institutions and page counts.
- 174 real INS PostgreSQL tests passed with the new index, including actual
  default-series/population queries and geographic ambiguity behavior.
- Old and new server builds returned identical complete response data in five
  bounded read-only Chronos comparisons: default, page 2, population sort,
  per-capita executives, and classification breakdown.

| Uncached local API       |   Before |    After |
| ------------------------ | -------: | -------: |
| Default page             | 2,708 ms | 2,195 ms |
| Page 2                   | 2,576 ms | 2,183 ms |
| Population sort          | 5,859 ms | 5,662 ms |
| Per capita               | 5,568 ms | 5,682 ms |
| Classification breakdown |   825 ms |   899 ms |

These single comparison samples include roughly 40 ms per Mac-to-DB round trip;
they are not deployed latency percentiles. The index was not applied live, so
population-heavy improvements are not claimed. Exact EXPLAIN showed the revised
second aggregation at 42 ms, versus 535 ms in the initial audit. Its fact scan was
restricted to page CUIs; the first full aggregation remained about 621 ms in that
later sample. Timing noise on unchanged paths is expected.

Production-built local browser checks disabled both HTML and API response caches:
one SSR ranking per default visit, no duplicate browser ranking; explicit EUR and
inflation settings stayed EUR/adjusted despite conflicting saved defaults; page-2
filter changes requested only the new first page. Warm-process first-byte times
were about 17 ms, but full table data still took about 2.1 seconds through the Mac
DB tunnel. Streaming the shell is not completion of the data load.

## Deployment boundary

No live DDL, data reload, push or deployment was performed in this implementation
step. Apply the exact scrapper index migration in a reviewed Chronos operation,
then publish/sync server and client dev revisions and repeat uncached measurements.
The migration bounds lock acquisition to 5 seconds and index construction to
60 seconds. Measure full catalog size/build time before applying; ordinary CREATE
INDEX permits reads but blocks writers while it builds. Do not run unrelated
pending migrations. No Phoenix production changes.

Evidence: scrapper `prod-db/evidence/entity-analytics-performance-2026-09-14/`;
local reproducible scripts/results `/private/tmp/entity-analytics-fix-20260914/`.
