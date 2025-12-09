# Entity Ranking Module Specification

**Status:** Draft  
**Last Updated:** 2025-12-09

---

## 1. Problem Statement

We need to rank ~13,000 public entities by **computed financial metrics** that aren't directly stored in the database. Examples:

- **Budget deficit**: Income - Expenses
- **Fiscal autonomy**: Own Revenue / Total Income
- **Personnel burden**: Personnel Expenses / Own Revenue
- **Viability classification**: Categorize entities based on whether own revenue covers costs

### The Core Challenge

Current analytics modules can filter and sort by database columns, but **ranking by computed values** requires:

1. Combining multiple data series (income, expenses, population)
2. Applying filters to each series (e.g., "only personnel expenses")
3. Computing a result per entity per period
4. Sorting and paginating by the computed result

**Why this is hard:** You can't paginate before computing, because the sort order depends on computed values. But computing 13,000 entities × 9 years of data on every request is too slow.

### The Two-Filter Problem

A ranking series requires **two separate filter contexts**:

1. **Entity Selection Filter** — Which entities participate in the ranking?
   - Examples: "only UATs", "only Cluj county", "population > 10,000"
   - Applied once to determine the set of entities to rank

2. **Data Computation Filter** — What data to aggregate per entity?
   - Examples: "personnel expenses (economic code 10.xx)", "2020-2024 yearly"
   - Applied to each entity individually to compute their metric value
   - **Entity fields are ignored** because we iterate over entities

This separation is critical: the data filter defines _what_ to measure, while the entity filter defines _who_ to measure.

### Identifying Underperformers

Beyond ranking, the system must identify entities that cross critical thresholds for reporting purposes. Examples:

- "All communes with fiscal autonomy < 20%"
- "Entities where personnel costs exceed own revenue"
- "UATs with deficit > 5M RON"

**Why this matters:** Rankings show relative position, but thresholds identify absolute problems. An entity ranked #500 nationally might still be healthy, while #100 might be struggling — ranking alone doesn't tell you.

**Use case:** Generate reports listing struggling entities for policy analysis and human review.

### Solution

**Pre-compute and store rankings.** Run batch computation jobs that:

1. Calculate metric values for each entity
2. Store results in dedicated tables
3. Pre-compute national and county-level ranks
4. Enable instant queries with pagination

---

## 2. Metrics Catalog

### 2.1 Fiscal Autonomy & Viability

| Metric                  | Formula                                      | Purpose                                |
| ----------------------- | -------------------------------------------- | -------------------------------------- |
| Fiscal Autonomy Index   | Own Revenue ÷ Total Income × 100             | How self-sufficient is the entity?     |
| Own Revenue Coverage    | Own Revenue − Personnel Expenses             | Can own revenue cover personnel?       |
| Administrative Coverage | Own Revenue − (Personnel + Goods & Services) | Can own revenue cover all admin costs? |
| Personnel Expense Ratio | Personnel ÷ Total Expenses × 100             | What % of budget goes to personnel?    |
| Personnel per Capita    | Personnel Expenses ÷ Population              | Staffing cost per resident             |

**Viability Classification:**

- **Category 1 (Fully Viable):** Own Revenue ≥ Personnel + Goods & Services
- **Category 2 (Partially Viable):** Own Revenue ≥ Personnel, but < Personnel + Goods & Services
- **Category 3 (Not Viable):** Own Revenue < Personnel

### 2.2 Aggregate Statistics (Dashboard)

| Statistic                                        | Description                                                   |
| ------------------------------------------------ | ------------------------------------------------------------- |
| % communes where Own Revenue < Personnel         | Share of communes that can't cover personnel from own revenue |
| % communes where Own Revenue < Personnel + Goods | Share that can't cover basic admin costs                      |
| Count of structurally dependent UATs             | UATs that were never viable (2016-2024)                       |
| Total equalization transfers to non-viable UATs  | How much money flows to struggling entities                   |

### 2.3 Trend Analysis

| Analysis                              | Description                                         |
| ------------------------------------- | --------------------------------------------------- |
| Fiscal autonomy trend (2016 vs 2024)  | How has self-sufficiency changed?                   |
| Personnel growth vs population change | Are personnel costs growing faster than population? |
| Viability category movement           | Which entities improved or declined?                |

### 2.4 Future: Fiscal Flow Analysis

> Requires external data from ANAF (tax authority) and INS (statistics).

- Income tax retention rate by county
- Net contributor vs net beneficiary counties
- Fiscal balance: taxes generated vs budget received
- Simulations: What if Romania adopted German/Polish revenue sharing models?

---

## 3. Data Series & Filters

### 3.1 Base Series

| Series ID    | Source             | Filter                    |
| ------------ | ------------------ | ------------------------- |
| `income`     | ExecutionLineItems | `account_category = 'vn'` |
| `expense`    | ExecutionLineItems | `account_category = 'ch'` |
| `population` | UATs table         | Entity's UAT population   |

### 3.2 Filtered Budget Series

To compute metrics like "personnel expenses," we need to filter by economic classification codes:

| Series ID            | Base    | Economic Code Prefix | Description                       |
| -------------------- | ------- | -------------------- | --------------------------------- |
| `own_revenue`        | income  | 01, 02, 03, 30       | Taxes, property income, fees      |
| `personnel_expense`  | expense | 10                   | Salaries, benefits, contributions |
| `goods_services`     | expense | 20                   | Goods and services                |
| `capital_expense`    | expense | 70, 71               | Capital investments               |
| `transfers_received` | income  | 42, 43               | Transfers from other budgets      |

### 3.3 Calculation Schema

Calculations are expressed as a tree of operations:

```
Deficit = subtract(income, expense)
Autonomy = percent(own_revenue, income)
Coverage = subtract(own_revenue, add(personnel_expense, goods_services))
```

**Supported operations:**

- Arithmetic: `add`, `subtract`, `multiply`, `divide`, `percent`
- Comparison: `lt`, `gt`, `eq` (returns 1 or 0)
- Conditional: `if(condition, then, else)`

**Example - Viability Score:**

```
if(own_revenue >= personnel + goods_services, 3,
   if(own_revenue >= personnel, 2, 1))
```

---

## 4. Series Architecture

### 4.1 Alignment with Client Chart Schema

The ranking series definition aligns with the client's `ChartSchema` for consistency. Both systems share:

- **Series references by ID** — Calculations reference other series by their unique identifier
- **Uniform series types** — Base series (data queries) and computed series (calculations)
- **Filter structure** — Uses the same `AnalyticsFilter` pattern for data queries

### 4.2 Series Types

| Type              | Description                             | Example                                |
| ----------------- | --------------------------------------- | -------------------------------------- |
| `base-series`     | Queries budget data with filters        | Income, Personnel Expenses             |
| `computed-series` | Mathematical operations on other series | Fiscal Autonomy = own_revenue ÷ income |
| `static-series`   | Pre-defined datasets (population, CPI)  | Population by UAT                      |

**Base Series Definition:**

```json
{
  "id": "own_revenue",
  "type": "base-series",
  "label": "Own Revenue",
  "unit": "RON",
  "dataFilter": {
    "account_category": "vn",
    "economic_prefixes": ["01.", "02.", "03.", "30."],
    "report_period": {
      "type": "YEAR",
      "selection": { "interval": { "start": "2020", "end": "2024" } }
    }
  }
}
```

**Computed Series Definition:**

```json
{
  "id": "fiscal_autonomy",
  "type": "computed-series",
  "label": "Fiscal Autonomy Index",
  "unit": "%",
  "calculation": { "op": "percent", "args": ["own_revenue", "income"] }
}
```

### 4.3 Series Dependencies

Computed series form a **directed acyclic graph (DAG)** of dependencies:

```
income ─────────────────┐
                        ├──> fiscal_autonomy
own_revenue ────────────┤
                        ├──> personnel_coverage
personnel_expense ──────┘
```

The computation engine:

1. Topologically sorts the dependency graph
2. Computes base series first (parallel)
3. Computes derived series in dependency order
4. Detects circular references at definition time

### 4.4 Unit Handling

#### Unit Algebra Rules

| Operation         | Rule                | Example                     |
| ----------------- | ------------------- | --------------------------- |
| `add`, `subtract` | Units must match    | RON + RON = RON ✓           |
| `multiply`        | Units combine       | RON × ratio = RON ✓         |
| `divide`          | Units derive        | RON ÷ people = RON/capita ✓ |
| `percent`         | Always produces `%` | RON ÷ RON × 100 = % ✓       |

#### Validation with Override

1. **Automatic validation** — System checks unit compatibility at series definition time
2. **Validation errors** — Invalid combinations (e.g., `RON + people`) show error
3. **Manual override** — Admin can explicitly set the result unit to fix validation errors

```json
{
  "id": "custom_metric",
  "calculation": { "op": "divide", "args": ["budget_total", "population"] },
  "unit": "RON/capita", // Explicit override
  "unitOverride": true // Indicates manual override
}
```

#### Common Unit Patterns

| Pattern          | Input Units   | Result Unit |
| ---------------- | ------------- | ----------- |
| Deficit/Surplus  | RON, RON      | RON         |
| Percentage/Ratio | RON, RON      | %           |
| Per Capita       | RON, people   | RON/capita  |
| Growth Rate      | RON, RON      | %           |
| Index            | dimensionless | index       |

---

## 5. Filter Architecture

### 5.1 Two-Context Filtering

Each ranking series has **two distinct filter contexts**:

#### Entity Selection Filter

Determines which entities participate in the ranking:

```json
{
  "entityFilter": {
    "is_uat": true,
    "county_codes": ["CJ", "TM"],
    "min_population": 5000,
    "entity_types": ["comuna", "oras"]
  }
}
```

**Supported entity filter fields:**

- `is_uat` — Boolean, filter to UATs only
- `county_codes` — Array of county codes
- `uat_ids` — Specific UAT identifiers
- `entity_types` — Entity type classifications
- `entity_cuis` — Specific entity CUIs
- `min_population`, `max_population` — Population range

#### Data Computation Filter

Defines what data to aggregate for each entity. Uses the full `AnalyticsFilter` schema but **entity-related fields are ignored**:

```json
{
  "dataFilter": {
    "account_category": "ch",
    "economic_prefixes": ["10."],
    "report_period": {
      "type": "YEAR",
      "selection": { "interval": { "start": "2020", "end": "2024" } }
    },
    "report_type": "Executie bugetara agregata la nivel de ordonator principal",

    "entity_cuis": ["IGNORED"], // ← Ignored, we iterate over entities
    "uat_ids": ["IGNORED"] // ← Ignored
  }
}
```

### 5.2 Filter Processing Flow

```
1. Apply entityFilter to get list of CUIs to process
       ↓
2. For each entity CUI:
   a. Clone dataFilter
   b. Set entity_cuis = [current_cui]
   c. Execute analytics query
   d. Store result
       ↓
3. Compute ranks across all results
```

### 5.3 Threshold-Based Filtering

#### Purpose

Filter ranking results to identify entities crossing critical thresholds. Used for generating reports of struggling (or exceptional) entities.

#### Threshold Definition

For MVP, thresholds are simple numeric comparisons:

```
{ "field": "value", "operator": "lt", "threshold": 20 }
```

**Supported operators:**

- `lt`, `lte` — less than, less than or equal
- `gt`, `gte` — greater than, greater than or equal
- `eq`, `neq` — equal, not equal

#### Period Considerations

**Open question:** How should thresholds apply when data spans multiple periods?

| Option            | Behavior                     | Use Case                 |
| ----------------- | ---------------------------- | ------------------------ |
| **Total/Average** | Apply to aggregated value    | "Overall performance"    |
| **Any period**    | Flag if ANY year crosses     | "Ever struggled"         |
| **Latest period** | Apply to most recent         | "Current status"         |
| **All periods**   | Flag only if ALL years cross | "Chronically struggling" |

> **Decision needed:** Define default behavior and whether users can choose.

#### Future Extensions

- **Multiple conditions:** AND/OR logic across metrics
- **Percentile thresholds:** "Bottom 10%" instead of absolute values
- **Trend thresholds:** "Declining for 3+ consecutive years"
- **Comparative thresholds:** "Below county average"

---

## 6. Storage Design

### 6.1 Why Pre-compute?

| Approach            | Pros                          | Cons                    |
| ------------------- | ----------------------------- | ----------------------- |
| Compute on request  | Always fresh                  | Too slow for pagination |
| Pre-compute & store | Fast queries, enables ranking | Stale until recomputed  |

We choose **pre-compute** because:

- Entity count (~13K) is bounded
- Data updates monthly (not real-time)
- Rankings must be paginatable and sortable

### 6.2 Database Tables

**ranking_series** - Defines what to compute

```
id, name, calculation (JSON), base_filter, period_granularity
computation_status, last_computed_at
```

**entity_ranking_values** - Stores computed totals + ranks

```
series_id, entity_cui
total_value, rank_national, rank_county, percentile
entity_name, county_code (denormalized for fast queries)
```

**entity_period_values** - Stores per-period breakdown

```
series_id, entity_cui, period
value, rank_national, rank_county
```

### 6.3 Pre-computed Ranks

After computing all entity values, we update ranks:

- **National rank:** Position among all entities
- **County rank:** Position within entity's county
- **Percentile:** What % of entities are below this one

When users filter (e.g., "show only Cluj county"), we compute a **dynamic rank within the result set** at query time.

---

## 7. Computation Pipeline

### 7.1 Process Flow

```
1. Trigger (manual or data sync)
       ↓
2. Create computation job
       ↓
3. Fetch all entity CUIs
       ↓
4. Process in batches (100 entities × 4 parallel workers)
   - Fetch budget data for batch
   - Evaluate calculation per entity per period
   - Store results
       ↓
5. Update ranks (single SQL after all batches)
       ↓
6. Mark job complete
```

### 7.2 Batch Processing

- **Batch size:** 100 entities
- **Parallel batches:** 4
- **Retry on failure:** 3 attempts
- **Estimated time:** ~2-5 minutes for full computation

### 7.3 Computation Triggers

| Trigger            | Series Type   | Frequency |
| ------------------ | ------------- | --------- |
| Data sync complete | System series | Monthly   |
| Manual trigger     | Admin series  | On demand |
| Series created     | New series    | Once      |

---

## 8. Query Patterns

### 8.1 Ranked Entity List

**Use case:** Display ranking table with pagination.

```sql
SELECT entity_cui, entity_name, total_value, rank_national, rank_county
FROM entity_ranking_values
WHERE series_id = 'fiscal_autonomy'
  AND county_code = 'CJ'  -- optional filter
ORDER BY rank_national
LIMIT 50 OFFSET 0;
```

### 8.2 Entity Rank Info

**Use case:** Show rank badges on entity detail page.

```sql
SELECT series_id, total_value, rank_national, rank_county, percentile
FROM entity_ranking_values
WHERE entity_cui = '12345678'
  AND series_id IN ('budget_deficit', 'fiscal_autonomy', 'personnel_per_capita');
```

### 8.3 Sort by Specific Period

**Use case:** Rank by 2024 values specifically.

```sql
SELECT erv.*, epv.value AS period_value
FROM entity_ranking_values erv
JOIN entity_period_values epv USING (series_id, entity_cui)
WHERE series_id = 'fiscal_autonomy' AND epv.period = '2024'
ORDER BY epv.value DESC;
```

### 8.4 Search Entity in Ranking

**Use case:** User searches for a specific entity and wants to jump directly to its position in the ranking table.

**Input:** Entity CUI (or name search) + Series ID + Page size

**Output:**

- Entity's rank and value
- Page number containing the entity
- Offset for pagination

**Calculation:**

```
page = floor((rank - 1) / pageSize) + 1
offset = (page - 1) * pageSize
```

**Example:** Entity ranked #127 with pageSize=50:

- Page = floor(126 / 50) + 1 = **3**
- Offset = (3 - 1) \* 50 = **100**
- UI navigates to page 3, entity appears at position 27 on that page

**Query pattern:**

```sql
SELECT
  entity_cui, entity_name, total_value, rank_national,
  CEIL(rank_national::float / :pageSize) AS page_number,
  (CEIL(rank_national::float / :pageSize) - 1) * :pageSize AS offset
FROM entity_ranking_values
WHERE series_id = :seriesId
  AND (entity_cui = :cui OR entity_name ILIKE :searchTerm)
```

---

## 9. Key Challenges

### 9.1 Defining "Own Revenue"

**Challenge:** Which economic codes constitute "own revenue"?

The Romanian budget classification has hundreds of economic codes. We need to define exactly which codes map to concepts like "own revenue" vs "transfers."

**Proposed mapping:**

- Own revenue: 01.xx (taxes), 02.xx (property), 03.xx (fees), 30.xx (operating income)
- Transfers: 42.xx (central transfers), 43.xx (other transfers)

> **TODO:** Validate these mappings with domain experts.

### 9.2 Population Data

**Challenge:** Not all entities have population.

- UATs have population directly
- County councils use county aggregate population
- Other entities (schools, hospitals) have no meaningful population

**Solution:** Per-capita metrics only apply to UATs and county councils. Other entities get `null` for per-capita rankings.

### 9.3 Historical Comparisons

**Challenge:** Comparing 2016 to 2024 requires consistent entity identification.

- Some entities merged or split
- CUI codes may have changed
- Budget classification codes evolved

**Solution:** Start with entities that exist in both periods. Flag data gaps.

### 9.4 External Data Dependencies

**Challenge:** Fiscal flow analysis requires data we don't have.

- ANAF tax collection data (not public)
- County-level GDP estimates
- Detailed demographic breakdowns

**Solution:** Phase implementation:

1. **Phase A:** Budget-only metrics (current data)
2. **Phase B:** Demographics integration (INS data)
3. **Phase C:** Fiscal flow estimates (proxies + available data)

---

## 10. Open Questions

- [ ] **Q1:** Which economic codes define "own revenue"? Need domain validation.
- [ ] **Q2:** How to handle entities without population for per-capita metrics?
- [ ] **Q3:** Should admin-created series be visible to all users?
- [ ] **Q4:** What's the acceptable staleness for rankings? (hours? days?)
- [ ] **Q5:** Do we need to track rank changes over time?
- [ ] **Q6:** How should thresholds apply across multiple periods? (total, any, latest, all)

---

## 11. Implementation Phases

### Phase 1: Core Infrastructure

- Database tables
- Calculation engine (evaluate expressions)
- Batch computation pipeline

### Phase 2: System Series

- Budget deficit, fiscal autonomy, personnel metrics
- Viability classification
- Automatic refresh on data sync

### Phase 3: Query & Display

- GraphQL API for rankings
- Entity page rank badges
- Ranking table with filters

### Phase 4: Admin Features

- Admin UI for creating custom series
- Computation monitoring
- Manual trigger controls

---

## Appendix: Example Calculation Definitions

### Budget Deficit

```json
{ "op": "subtract", "args": ["income", "expense"] }
```

### Fiscal Autonomy Index

```json
{ "op": "percent", "args": ["own_revenue", "income"] }
```

### Personnel Coverage

```json
{ "op": "subtract", "args": ["own_revenue", "personnel_expense"] }
```

### Viability Category

```json
{
  "type": "classification",
  "rules": [
    {
      "name": "Fully Viable",
      "condition": {
        "op": "gte",
        "args": ["own_revenue", { "op": "add", "args": ["personnel_expense", "goods_services"] }]
      }
    },
    {
      "name": "Partially Viable",
      "condition": { "op": "gte", "args": ["own_revenue", "personnel_expense"] }
    },
    { "name": "Not Viable", "default": true }
  ]
}
```

---

## Appendix B: Future Work

### B.1 Predictions & Simulations

**Status:** Deferred to future phase

For forward-looking analysis, we may want to support scenarios like:

- "What if personnel costs grow 5% yearly for the next 5 years?"
- "What if Romania adopted the German revenue sharing model?"
- "Project fiscal autonomy trends to 2030"

**Potential Approaches:**

1. **Scenario Parameters Table** — Store simulation definitions (growth rates, policy changes, model parameters) and compute projections as virtual series

2. **Transformation Functions** — Extend calculations with projection operators:

   ```json
   { "op": "project", "args": ["personnel_expense"], "growth": 0.05, "years": 5 }
   ```

3. **External Model Integration** — Allow importing projection results from external tools (Excel, Python scripts)

**Requirements to Define (Future):**

- How are scenarios stored and versioned?
- Can users create their own scenarios?
- How do we visualize uncertainty/confidence intervals?
- Should projections participate in rankings?

### B.2 Entity Grouping & Comparisons

**Status:** Deferred to future phase

Comparing groups of entities rather than individuals would enable analyses like:

- "Small communes (< 3,000 pop) vs medium towns (3,000-10,000) vs cities (> 10,000)"
- "Rural UATs vs Urban UATs"
- "Counties in the North-West region"
- "All entities receiving EU structural funds"

**Potential Design:**

1. **Named Groups** — Admin-defined entity sets with criteria:

   ```json
   {
     "id": "small_communes",
     "label": "Small Communes (< 3,000)",
     "criteria": {
       "is_uat": true,
       "entity_types": ["comuna"],
       "max_population": 3000
     }
   }
   ```

2. **Dynamic Grouping** — Define grouping dimensions at query time:

   ```json
   {
     "groupBy": "population_bracket",
     "brackets": [
       { "label": "< 3K", "max": 3000 },
       { "label": "3K-10K", "min": 3000, "max": 10000 },
       { "label": "> 10K", "min": 10000 }
     ]
   }
   ```

3. **Hierarchical Aggregation** — Pre-compute county and region rollups

**Questions to Resolve (Future):**

- How is a group's aggregate value computed? (sum, average, median, weighted?)
- Can groups overlap? (same entity in multiple groups)
- Should groups be ranked against each other?
- How do we handle groups with different entity counts?

### B.3 Intermediate Computation Caching

**Status:** Implemented via named base series

For efficiency, common sub-computations (e.g., "own_revenue" used in multiple metrics) are stored as **named base series** that can be referenced by multiple computed series.

**Current Approach:**

- Define base series explicitly (own_revenue, personnel_expense, etc.)
- Computed series reference base series by ID
- Computation engine evaluates in dependency order
- Base series results are cached during batch computation

**Future Enhancement:**

- Content-addressed caching using computation hash
- Automatic deduplication of identical sub-expressions
- Cache invalidation on data refresh
