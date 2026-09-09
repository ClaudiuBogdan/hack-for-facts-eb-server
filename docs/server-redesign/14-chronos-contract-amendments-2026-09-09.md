# 14 — Chronos contract amendments the client must absorb (2026-09-09)

> **Status:** owner decisions of the Chronos migration review
> (`docs/reviews/chronos-migration-2026-09-09/README.md` §8: D/DP-02, D/DP-04, N/N3),
> verified with bounded read-only queries on Chronos `transparenta_prod` and Phoenix
> dev on 2026-09-09. Conforms to [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md)
> and amends [`13-legacy-roots-on-kernel.md`](./13-legacy-roots-on-kernel.md).

## 1. `isUat` is strict (D/DP-02)

| Store   | County councils (41)                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phoenix | `entities.is_uat = true` (3,228 rows `is_uat`)                                                                                                        |
| Chronos | `core.public_entities.is_uat = false`, `is_territorial_executive = true`, `entity_type = 'uat'` (3,187 rows `is_uat`, 3,228 rows `entity_type='uat'`) |

Decision: **`isUat: true` means UAT only** (communes, towns, municipalities, sectors).
County councils are reached through **`isTerritorialExecutive: true`**; the per-capita
paths already use the executive flag. No server change; a client filter that wants the
Phoenix meaning of "all territorial executives" must send `isTerritorialExecutive`.

## 2. The entity-type vocabulary is Chronos's (D/DP-04)

Chronos `core.public_entities.entity_type` is canonical and the reference API exposes it
raw. The Phoenix `entities.entity_type` values map as follows (CUI join, 2026-09-09):

| Phoenix (`entities.entity_type`)                                                                                                                                                                                                                                     | Chronos (`core.public_entities.entity_type`)                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admin_commune_hall` (2,862), `admin_town_hall` (216), `admin_municipality` (104), `admin_county_council` (42), `admin_sector_hall` (6) — 3,230 rows                                                                                                                 | `uat` (3,228; county councils carry `is_territorial_executive = true`, `is_uat = false`)                                                                                                                                 |
| `education` (6,708), `public_entity` (2,096→2,097), `health` (632), `public_order` (591), `culture` (438), `sports` (422), `social` (333), `utilities` (211→210), `research` (152), `justice` (128), `central_authority` (57), `penitentiary` (42), `transport` (18) | the same name (14 coarse types in total)                                                                                                                                                                                 |
| the fine-grained subtypes `edu_*`, `health_clinic`, `health_*_hospital`, `culture_*`, `social_*`, `sport_club`, `utilities_*`, `finance_*`, `environment_agency`, `admin_ministry`, `admin_central_agency`, `uncategorized` (255 rows)                               | **no `core.public_entities` row** (except the 6 `admin_sector_hall` → `uat`). All 255 exist in `core.organizations`; none but the 6 has 2025 execution facts — they are non-reporting organisations, not lost reporters. |

Arithmetic note: the five Phoenix `admin_*` rows sum to 3,230 against 3,228 Chronos `uat`
rows, and Phoenix has 42 `admin_county_council` rows against 41 Chronos rows flagged
`is_territorial_executive and not is_uat` — two Phoenix administrative rows have no Chronos
public-entity row (not reconciled by CUI here; the 255-row subtype join above covered only the
fine-grained types).

Client rule: filter and label on the 14 Chronos names; drop the `admin_*` / `edu_*`
sub-vocabulary. The legacy grouped typedef's `entity_type` description now lists Chronos
examples (`uat`, `public_entity`, `education`); the frozen legacy SDL fixture keeps the old text.

## 3. Population admission pins stay in code (N/N3) — republish procedure and blast radius

The kernel serves population only from **admitted** INS publications, pinned in
`src/modules/ins-native/shell/population/admissions.ts` (`NATIVE_MAP_POPULATION_ADMISSION`:
POP107D `revisionId '1051'`, custody and transform SHA-256;
`NATIVE_SECTOR_POPULATION_ADMISSION`: eight Bucharest sector sources with object
versions, their `rowsSha256`, admitted years 2017–2020, 2022–2025). Every read re-validates the pins and fails
closed with `ServiceUnavailable` on a mismatch. Owner decision: the pins **stay in code
through production** (no DB-side promoted pointer yet).

**Blast radius of a drift** (a scrapper re-publication of POP107D, a sector re-load —
the source string embeds the object version — or a new native sector node): not only
per-capita reads. `rankEntitiesPage` (`budget-repo.ts`, behind the native wrapper that always
opens the population snapshot) and `makeGroupedAnalyticsRepo` call the population relation for
**nominal** pages too and propagate the error, so `budgetEntityRanking` /
`budgetEntityRankingPage`, the grouped `entityAnalytics` (entity grouping) and the native map
per-capita series return `ServiceUnavailable` until re-admission. Nominal `executionTimeseries`
and `listExecutionLineItems` early-return to the base repo and never touch population. Sector
admission is validated on every population read, so a Bucharest-only drift breaks a Cluj ranking.

**Republish procedure** (server side, after the scrapper publishes a new POP107D revision
or sector load):

1. Read the new publication's identity on Chronos: `ins.dataset_revisions` (revision id,
   transform contract SHA) and `ins.datasets.pivot_custody_sha256` for `POP107D`; the
   sector source strings (`ins-bucharest-domicile-jan1:<year>:<object version>`) from
   `core.territory_population.source` (or the loader manifest).
2. Verify the national totals and a sample of cells against the original INS responses
   (the 2026-09-07 admission did this by hand; keep the evidence next to the review).
3. Update the constants in `admissions.ts`. `pnpm vitest run tests/unit/ins-native` only
   checks the admission's SHAPE (64-hex digests, source count = year count, the year-set
   shapes) — a wrong digest or revision passes it. The pins are proven only by a live read
   against Chronos: the budget golden suites (`PROD_DATABASE_URL`) or one per-capita probe
   through `readAnnualPopulation` / `readAdmittedSectorPopulation`.
4. Deploy; until the deploy lands every population-dependent read fails closed — schedule
   the scrapper publication and the server release together.

Before production the review recommends moving the admission to a DB-side promoted pointer
read at request time (like `core.factor_sets.promoted_at` + digest), letting nominal roots
degrade to `population: null`, and validating sector admission only when a sector anchor is
in the requested set. Those are open items, not decisions.
