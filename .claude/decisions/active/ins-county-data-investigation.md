# INS County Data Investigation Report

**Date:** 2026-02-01
**Database:** `postgresql://ins_tempo:ins_tempo@jupiter:5432/ins_tempo`
**Context:** Entity page needs to display INS statistical data for both UAT (municipality/town/commune) entities and county council entities. The client reports empty results when querying county-level data.

---

## 1. Executive Summary

County-level INS data works differently than expected. The `has_county_data` flag on datasets does **not** mean observations exist at NUTS3 (county) level. For 85 out of 99 county-flagged datasets, data is stored only at LAU (locality) level and must be aggregated by county via the territorial hierarchy. Only 14 datasets have actual pre-computed NUTS3 observations.

The client's `getInsCountyDashboard` function fails because:

1. It tries SIRUTA codes for counties, but NUTS3 territories have no SIRUTA codes
2. Its fallback using `territoryCodes` works, but only finds the 14 county-only datasets
3. The 85 most relevant datasets (population, housing, education, etc.) have zero NUTS3 observations

---

## 2. Territory Structure

### Query: NUTS3 (County) Territories

```sql
SELECT code, siruta_code, level, name, parent_id
FROM territories
WHERE level = 'NUTS3'
ORDER BY code
LIMIT 50;
```

**Result:** 42 counties found. All have `siruta_code = NULL`.

| code | siruta_code | level | name      | parent_id |
| ---- | ----------- | ----- | --------- | --------- |
| AB   | (null)      | NUTS3 | Alba      | 7         |
| AR   | (null)      | NUTS3 | Arad      | 13        |
| B    | (null)      | NUTS3 | Bucuresti | 11        |
| CJ   | (null)      | NUTS3 | Cluj      | 6         |
| ...  | ...         | ...   | ...       | ...       |

**Finding:** Counties are identified by `territories.code` (2-char auto prefix like `CJ`, `AB`, `B`), NOT by SIRUTA codes. The `siruta_code` column is NULL for all NUTS3 territories. SIRUTA codes only exist on LAU (locality) level territories.

### Query: Territory Hierarchy (Cluj-Napoca Example)

```sql
SELECT t.code, t.siruta_code, t.level, t.name, t.path::text, p.code as parent_code, p.level as parent_level
FROM territories t
LEFT JOIN territories p ON p.id = t.parent_id
WHERE t.siruta_code = '54975'
   OR (t.code = 'CJ' AND t.level = 'NUTS3');
```

**Result:**

| code  | siruta_code | level | name                   | path                 | parent_code | parent_level |
| ----- | ----------- | ----- | ---------------------- | -------------------- | ----------- | ------------ |
| CJ    | (null)      | NUTS3 | Cluj                   | RO.RO1.RO11.CJ       | RO11        | NUTS2        |
| 54975 | 54975       | LAU   | MUNICIPIUL CLUJ-NAPOCA | RO.RO1.RO11.CJ.54975 | CJ          | NUTS3        |

**Finding:** LAU territories are children of NUTS3 in the ltree hierarchy. Cluj-Napoca (LAU, siruta 54975) is under Cluj (NUTS3, code CJ). The path pattern is: `RO.{macroregion}.{region}.{county}.{locality}`.

### Query: LAU Count Under Cluj County

```sql
SELECT COUNT(*) as lau_count
FROM territories
WHERE path <@ 'RO.RO1.RO11.CJ' AND level = 'LAU';
```

**Result:** `81` LAU localities under Cluj county.

---

## 3. Dataset Distribution by Territorial Flags

### Query: Flag Combinations

```sql
SELECT
  SUM(CASE WHEN has_uat_data AND has_county_data THEN 1 ELSE 0 END) as both,
  SUM(CASE WHEN has_uat_data AND NOT has_county_data THEN 1 ELSE 0 END) as uat_only,
  SUM(CASE WHEN NOT has_uat_data AND has_county_data THEN 1 ELSE 0 END) as county_only,
  SUM(CASE WHEN NOT has_uat_data AND NOT has_county_data THEN 1 ELSE 0 END) as neither,
  COUNT(*) as total
FROM v_matrices;
```

**Result:**

| both | uat_only | county_only | neither | total |
| ---- | -------- | ----------- | ------- | ----- |
| 85   | 0        | 14          | 1,799   | 1,898 |

**Finding:**

- **85 datasets** flagged as both `has_uat_data` AND `has_county_data`
- **14 datasets** flagged as `has_county_data` only
- **0 datasets** are UAT-only (every UAT dataset also has county flag)
- **1,799 datasets** have neither flag (national/regional level only)

---

## 4. Where Observations Actually Exist

### Query: Territory Levels for UAT+County Datasets (85 datasets)

```sql
SELECT t.level, COUNT(DISTINCT m.ins_code) as dataset_count, COUNT(s.id) as obs_count
FROM statistics s
JOIN matrices m ON m.id = s.matrix_id
JOIN territories t ON t.id = s.territory_id
JOIN v_matrices vm ON vm.id = m.id
WHERE vm.has_uat_data = true AND vm.has_county_data = true
GROUP BY t.level
ORDER BY t.level;
```

**Result:**

| level    | dataset_count | obs_count  |
| -------- | ------------- | ---------- |
| NATIONAL | 84            | 14,784     |
| LAU      | 85            | 22,503,515 |

**Critical Finding:** The 85 datasets flagged with both `has_uat_data` and `has_county_data` have **ZERO NUTS3 observations**. Data exists only at LAU and NATIONAL levels. The `has_county_data` flag means the dataset has a county dimension in its nomenclator structure, but the actual statistical data is stored at individual locality (LAU) level.

### Query: Territory Levels for County-Only Datasets (14 datasets)

```sql
SELECT t.level, COUNT(DISTINCT m.ins_code) as dataset_count, COUNT(s.id) as obs_count
FROM statistics s
JOIN matrices m ON m.id = s.matrix_id
JOIN territories t ON t.id = s.territory_id
JOIN v_matrices vm ON vm.id = m.id
WHERE vm.has_county_data = true AND vm.has_uat_data = false
GROUP BY t.level
ORDER BY t.level;
```

**Result:**

| level    | dataset_count | obs_count |
| -------- | ------------- | --------- |
| NATIONAL | 14            | 20,793    |
| NUTS3    | 14            | 766,302   |

**Finding:** Only the 14 county-only datasets have actual pre-computed NUTS3 observations (766K total).

### Query: NUTS3 Observations for UAT+County Datasets

```sql
SELECT m.ins_code, COUNT(s.id) as obs_count
FROM statistics s
JOIN matrices m ON m.id = s.matrix_id
JOIN territories t ON t.id = s.territory_id
JOIN v_matrices vm ON vm.id = m.id
WHERE t.code = 'CJ' AND t.level = 'NUTS3'
  AND vm.has_uat_data = true AND vm.has_county_data = true
GROUP BY m.ins_code
ORDER BY m.ins_code;
```

**Result:** `0 rows` — Confirms no NUTS3 data exists for these datasets.

---

## 5. The 14 County-Only Datasets

### Query: List County-Only Datasets

```sql
SELECT ins_code, name_ro
FROM v_matrices
WHERE has_county_data = true AND has_uat_data = false
ORDER BY ins_code;
```

**Result:**

| ins_code | name_ro                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| EXP101J  | Exporturi (FOB) pe judete si pe sectiuni/capitole ale NC - date lunare        |
| EXP102J  | Importuri (CIF) pe judete si pe sectiuni/capitole ale NC - date lunare        |
| PPA102B  | Preturile medii de achizitie ale principalelor produse agricole pe judete     |
| TAN0131  | Tinta 3 - Mediu - Nr. interventii IGSU pe medii de rezidenta si judete        |
| TAZ0221  | Tinta 2 - Economic - Suprafata terenurilor intabulate pe categorii            |
| TBD0232  | Tinta 3 - Mediu - Suprafata protejata cu sisteme antigrindina                 |
| TCT0345  | Tinta 4 - Social - Rata mortalitatii neonatale                                |
| TDH0384  | Tinta 8 - Social - Rata sinuciderilor                                         |
| TOE1271  | Tinta 8 - Mediu - Suprafata spatiilor verzi pe judete                         |
| TOR1321  | Tinta 2 - Mediu - Suprafata protejata cu sisteme antigrindina                 |
| TOS1322  | Tinta 2 - Mediu - Nr. interventii IGSU cauzate de fenomene meteo              |
| TRH1571  | Tinta 7 - Mediu - Suprafata terenurilor amenajate cu lucrari de irigatii      |
| TRI1572  | Tinta 7 - Mediu - Suprafata terenurilor amenajate pentru combaterea eroziunii |
| ZDF1123  | Orizont 7 - Economic - Soldul balantei comerciale pe judete                   |

**Finding:** These are primarily trade/export data (EXP*) and Sustainable Development Goal indicators (T* prefix). They contain pre-aggregated county-level statistics. While useful, they miss the most relevant indicators for an entity page (population, housing, education, health, infrastructure).

### Query: Sample County Observation (CJ, 2022)

```sql
SELECT m.ins_code, s.value, s.value_status,
       t.code as terr_code, t.level as terr_level, t.siruta_code,
       tp.year, tp.periodicity,
       u.code as unit_code, u.symbol
FROM statistics s
JOIN matrices m ON m.id = s.matrix_id
JOIN territories t ON t.id = s.territory_id
JOIN time_periods tp ON tp.id = s.time_period_id
LEFT JOIN units_of_measure u ON u.id = s.unit_id
WHERE t.code = 'CJ' AND t.level = 'NUTS3'
  AND tp.year = 2022
ORDER BY m.ins_code
LIMIT 15;
```

**Result:**

| ins_code | value  | terr_code | terr_level | siruta_code | year | periodicity | unit_code     | symbol  |
| -------- | ------ | --------- | ---------- | ----------- | ---- | ----------- | ------------- | ------- |
| EXP101J  | 202506 | CJ        | NUTS3      | (null)      | 2022 | MONTHLY     | THOUSAND_EURO | mii EUR |
| EXP101J  | 47     | CJ        | NUTS3      | (null)      | 2022 | MONTHLY     | THOUSAND_EURO | mii EUR |
| EXP101J  | 10     | CJ        | NUTS3      | (null)      | 2022 | MONTHLY     | THOUSAND_EURO | mii EUR |
| ...      | ...    | ...       | ...        | ...         | ...  | ...         | ...           | ...     |

**Finding:** NUTS3 observations have `siruta_code = NULL` (inherited from the territory). Export data is MONTHLY periodicity with values in thousands of euros.

### Query: Total NUTS3 Observations Per Dataset for CJ

```sql
SELECT m.ins_code, COUNT(s.id) as obs_count
FROM statistics s
JOIN matrices m ON m.id = s.matrix_id
JOIN territories t ON t.id = s.territory_id
WHERE t.code = 'CJ' AND t.level = 'NUTS3'
GROUP BY m.ins_code
ORDER BY m.ins_code;
```

**Result:**

| ins_code | obs_count |
| -------- | --------- |
| EXP101J  | 9,673     |
| EXP102J  | 10,163    |
| PPA102B  | 21        |
| TAN0131  | 54        |
| TAZ0221  | 54        |
| TCT0345  | 8         |
| TDH0384  | 8         |
| TOE1271  | 9         |
| TOS1322  | 27        |
| TRH1571  | 11        |
| TRI1572  | 54        |
| ZDF1123  | 5         |

**Finding:** 12 of 14 county-only datasets have data for Cluj. Export/import datasets are very large (9-10K observations each due to monthly data with many product classifications). SDG datasets are small (5-54 observations).

---

## 6. LAU Aggregation Feasibility

### Query: Can We Aggregate LAU Data to County Level?

```sql
-- Total housing (LOC101B, TOTAL ownership class) for all CJ localities in 2022
SELECT COUNT(*) as lau_obs_count, SUM(s.value) as county_total
FROM statistics s
JOIN matrices m ON m.id = s.matrix_id
JOIN territories t ON t.id = s.territory_id
JOIN time_periods tp ON tp.id = s.time_period_id
LEFT JOIN statistic_classifications sc ON sc.matrix_id = s.matrix_id AND sc.statistic_id = s.id
LEFT JOIN classification_values cv ON cv.id = sc.classification_value_id
WHERE m.ins_code = 'LOC101B'
  AND t.path <@ 'RO.RO1.RO11.CJ' AND t.level = 'LAU'
  AND tp.year = 2022 AND tp.periodicity = 'ANNUAL'
  AND cv.code = 'TOTAL';
```

**Result:**

| lau_obs_count | county_total |
| ------------- | ------------ |
| 81            | 366,341      |

**Finding:** Aggregation works. 81 LAU localities in Cluj county sum to 366,341 total housing units. This matches what INS would report at county level. The ltree path operator (`<@`) efficiently finds all descendants.

**Caveat:** Not all indicators are summable. Rates (%), averages, and per-capita values cannot be simply summed. The aggregation strategy depends on the unit of measure and the nature of the indicator.

---

## 7. Client-Side Issue Analysis

### File: `hack-for-facts-eb-client/src/lib/api/ins.ts`

The `getInsCountyDashboard` function (line 169-243) attempts two strategies:

#### Strategy 1 (lines 177-186): SIRUTA-based query

```typescript
const sirutaCandidates = buildCountySirutaCandidates(params.countyCode, params.sirutaCode);
// For countyCode='CJ', produces: ['CJ', '12', '127']
const filter = {
  sirutaCodes: sirutaCandidates, // queries t.siruta_code IN ('CJ', '12', '127')
  territoryLevels: ['NUTS3'],
};
```

**Why it fails:** NUTS3 territories have `siruta_code = NULL`. The filter `t.siruta_code IN ('CJ', '12', '127')` matches nothing.

#### Strategy 2 / Fallback (lines 230-240): Territory code query

```typescript
const fallbackFilter = {
  territoryCodes: [params.countyCode], // queries t.code IN ('CJ')
  territoryLevels: ['NUTS3'],
};
```

**Why it appears to fail:** This query itself works and finds observations for the 14 county-only datasets. However, the function is called with `datasetCodes` from the caller (typically UAT-level datasets like `LOC101B`, `POP107D`, etc.). These datasets have no NUTS3 observations, so the batch query returns empty connections, and the `buildGroups` function filters them out at line 211 (`observations.length === 0`).

### File: `hack-for-facts-eb-client/src/lib/ins/county-siruta-map.ts`

#### `COUNTY_PREFIX_TO_SIRUTA` map (line 18-61)

Maps county auto prefixes to ordinal numbers (1-40, 51-52):

```typescript
CJ: 12,  // These are NOT SIRUTA codes
AB: 1,   // They are "cod judet" ordinals from the 1968 administrative reform
```

**Issue:** These ordinal numbers don't exist anywhere in the INS database. They are neither `territories.code` nor `territories.siruta_code`.

#### `buildCountySirutaCandidates` function (line 78-105)

Produces a set of candidate values: the county prefix (`CJ`), the ordinal (`12`), and a SIRUTA prefix (`127`). None of these match NUTS3 territory `siruta_code` (which is NULL).

---

## 8. Budget DB ↔ INS DB Linking

### Budget DB Entity Model

```
Entities.uat_id → UATs.id
                  UATs.county_code = 'CJ' (2-char code)
                  UATs.siruta_code = '54975' (actual SIRUTA for localities)
```

For county council entities (`entity_type = 'admin_county_council'`):

- `UATs.siruta_code = UATs.county_code` convention (e.g., siruta_code='CJ')
- Bucharest exception: `county_code='B'`, `siruta_code='179132'`

### INS DB Territory Model

```
territories.code = 'CJ'     (NUTS3, siruta_code=NULL)
territories.code = '54975'  (LAU, siruta_code='54975')
```

### Correct Linking Strategy

| Entity Type                     | Budget DB Field    | INS DB Filter             | Territory Level                                                                             |
| ------------------------------- | ------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| UAT (municipality/town/commune) | `UATs.siruta_code` | `t.siruta_code = '54975'` | LAU                                                                                         |
| County Council                  | `UATs.county_code` | `t.code = 'CJ'`           | NUTS3 (for 14 datasets) or aggregate LAU via `t.path <@ 'RO.RO1.RO11.CJ'` (for 85 datasets) |

---

## 9. Options for County Entity Pages

### Option A: Use Only the 14 County-Only Datasets

- **Pros:** Simple, data exists at NUTS3, no aggregation needed
- **Cons:** Limited to trade data (EXP*) and SDG indicators (T*). Misses population, housing, education, health, infrastructure — the most relevant indicators for an entity page.

### Option B: Aggregate LAU Data by County (Server-Side)

- **Pros:** Access to all 85 UAT datasets at county level. Rich data covering all domains.
- **Cons:** Requires server-side aggregation query using ltree. Not all indicators are summable (rates, averages need special handling). Query may be heavy for large counties.

### Option C: Hybrid Approach

- For 14 county-only datasets: fetch NUTS3 observations directly
- For 85 UAT datasets: aggregate LAU observations using `t.path <@ '{county_path}'`
- **Pros:** Most complete data coverage
- **Cons:** Most complex implementation. Need to handle non-summable indicators.

### Aggregation Caveats for Option B/C

- **Summable:** counts (nr.), persons (pers.), areas (ha, m², km), volumes (mii m³), energy (Gcal)
- **NOT summable:** rates (%), averages, per-capita values, prices (lei/kg)
- Need to either skip non-summable indicators or use weighted averages with population as weights

---

## 10. Immediate Fix (Client-Side)

To get _some_ county data working now, the client should:

1. Remove `COUNTY_PREFIX_TO_SIRUTA` — those ordinal numbers are not used anywhere
2. Skip the SIRUTA strategy entirely for counties
3. Query directly with `territoryCodes: [countyCode]` (no `territoryLevels` filter needed if code is unique)
4. Pass county-only dataset codes: `['EXP101J', 'EXP102J', 'PPA102B', 'ZDF1123', 'TOE1271', 'TCT0345', 'TDH0384', ...]`

For the full 85 datasets, a server-side `insCountyDashboard` query is needed.
