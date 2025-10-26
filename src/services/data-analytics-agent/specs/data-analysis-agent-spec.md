## Specification: MCP Data Analytics Tools for External AI Agents

**Version:** 1.0
**Purpose:** Define the tools that external AI agents can use to query, analyze, and visualize Romanian public budget data via the Model Context Protocol (MCP).

---

## Table of Contents

1. [System Overview](#1-system-overview--goal)
2. [Architecture](#2-architecture)
3. [Agent Workflow](#3-agent-workflow--master-prompt)
4. [Tool Definitions](#4-tool-definitions)
5. [Data Model Reference](#5-data-model-reference)
6. [Workflow Examples](#6-workflow-examples)
7. [Advanced Features](#7-advanced-features)
8. [Implementation Details](#8-implementation-details)

---

## 1. System Overview & Goal

### Core Philosophy: "Bring Your Own Agent"

The system exposes **two powerful, low-level tools** via MCP. External AI agents (Claude Desktop, GPT, custom agents) use these tools to perform budget analytics **autonomously**.

**Division of Responsibilities:**

| Component | Responsibility |
|-----------|---------------|
| **External AI Agent** | Natural language understanding, query planning, analysis synthesis, user communication |
| **MCP Tools** | Data discovery (search), data retrieval (analytics), statistics calculation |

### Agent Workflow

```
User Query
    ↓
┌───────────────────┐
│  AI Agent         │
│  - Parse intent   │
│  - Plan approach  │
└────────┬──────────┘
         ↓
┌────────────────────────────────────┐
│  1. SEARCH PHASE                   │
│  Tool: search_data                 │
│  Find IDs for filters              │
└────────┬───────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  2. GENERATE PHASE                 │
│  Tool: generate_chart_data         │
│  Fetch data, calculate statistics  │
└────────┬───────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  3. ANALYZE PHASE                  │
│  Agent interprets data & stats     │
│  Presents insights + chart URL     │
└────────────────────────────────────┘
```

---

## 2. Architecture

### Technology Stack

- **Protocol**: Model Context Protocol (MCP)
- **Data Source**: PostgreSQL database with partitioned execution line items
- **Search**: pg_trgm similarity search with Romanian diacritics support
- **Analytics**: GraphQL `executionAnalytics` resolver (YEAR/MONTH/QUARTER granularity)
- **Validation**: Zod schemas
- **Type Safety**: Full TypeScript typing with `AnalyticsFilter` interface

### Data Hierarchy

```
┌─────────────────────────────────────────────────┐
│  DIMENSIONS (What to filter by)                 │
├─────────────────────────────────────────────────┤
│                                                 │
│  Geographic:                                    │
│  └─ UATs (Territorial Units)                    │
│     └─ Counties (județe): CJ, B, TM, etc.       │
│     └─ Cities/Communes: Cluj-Napoca, etc.       │
│                                                 │
│  Institutional:                                 │
│  └─ Entities (Public Institutions)              │
│     └─ By CUI (fiscal ID): 12345678             │
│     └─ Types: school, hospital, city_hall       │
│                                                 │
│  Functional (WHAT is spent on):                 │
│  └─ COFOG3 Codes                                │
│     └─ 70. = Education                          │
│     └─ 84. = Healthcare                         │
│     └─ 60. = Infrastructure                     │
│                                                 │
│  Economic (HOW is spent):                       │
│  └─ Economic Codes                              │
│     └─ 20. = Personnel/Salaries                 │
│     └─ 30. = Goods & Services                   │
│     └─ 60. = Capital Investments                │
│                                                 │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  MEASURES (What to calculate)                   │
├─────────────────────────────────────────────────┤
│                                                 │
│  Account Categories:                            │
│  └─ "ch" = Expenses (Cheltuieli)                │
│  └─ "vn" = Revenue (Venituri)                   │
│                                                 │
│  Normalization:                                 │
│  └─ "total" = Absolute RON                      │
│  └─ "per_capita" = RON per person               │
│  └─ "total_euro" = Absolute EUR                 │
│  └─ "per_capita_euro" = EUR per person          │
│                                                 │
│  Time Granularity:                              │
│  └─ YEAR = Annual data points                   │
│  └─ MONTH = Monthly data points                 │
│  └─ QUARTER = Quarterly data points             │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## 3. Agent Workflow & Master Prompt

### Master Prompt for External Agents

External AI agents should be configured with this system prompt:

```markdown
# Romanian Public Budget Data Analyst

You are an expert data analyst specializing in Romanian public budget execution data.
You have access to comprehensive budget analytics tools via MCP.

## Your Workflow

### Phase 1: SEARCH - Find Filter IDs
**Tool**: `search_data`

You CANNOT use plain text in analytics queries. You MUST first search for machine-readable IDs.

**Critical Distinction - Entity vs UAT:**

- **Entity** (search_category='entity'):
  - Specific PUBLIC INSTITUTIONS (schools, hospitals, ministries, city halls)
  - Each has unique CUI (fiscal identifier)
  - Example: "Municipiul Cluj-Napoca" → CUI for that specific city hall
  - Use `entity_cuis` filter for institution-specific analysis

- **UAT** (search_category='uat'):
  - GEOGRAPHIC ADMINISTRATIVE UNITS (counties, cities, communes)
  - Numeric IDs representing territories
  - Example: "Cluj" → UAT ID for Cluj County (includes ALL entities in the county)
  - Use `uat_ids` filter for regional/geographic analysis

**When to use each:**
- Entity: "Show spending by Cluj-Napoca City Hall" → search entity
- UAT: "Show total education spending in Cluj County" → search UAT

**Classifications:**

- **Functional** (search_category='functional_classification'):
  - WHAT money is spent ON (purpose/function)
  - COFOG3 codes: "70." = education, "84." = healthcare
  - Use `functional_prefixes` for categories, `functional_codes` for exact items

- **Economic** (search_category='economic_classification'):
  - HOW money is spent (type of expense)
  - Economic codes: "20." = salaries, "30." = goods/services, "60." = investments
  - Use `economic_prefixes` for categories, `economic_codes` for exact items

### Phase 2: GENERATE - Create Analytics
**Tool**: `generate_chart_data`

Build series definitions with the IDs from Phase 1.

**Required Fields:**
- `report_period`: Time range (YEAR/MONTH/QUARTER)
- `account_category`: "ch" (expenses) or "vn" (revenue)

**Normalization Best Practices:**
- ALWAYS use `"per_capita"` when comparing counties/cities of different sizes
- Use `"total"` for absolute amounts
- Use `"*_euro"` variants for international comparisons

**Important:**
- UAT IDs must be STRINGS: `uat_ids: ["123"]` not `[123]`
- Functional/economic prefixes need trailing dots: `["70."]` not `["70"]`
- For categories use `*_prefixes`, for exact matches use `*_codes`

### Phase 3: ANALYZE - Interpret & Present
Use returned data to provide insights:
- Examine `data_points` for trends
- Use pre-calculated `statistics` (min, max, avg, sum, count)
- Identify patterns, growth rates, comparisons
- Present findings with the `chart_url` for visualization

## Data Concepts You Must Know

- **Account Categories**: "ch" = expenses, "vn" = revenue
- **Report Types**: Principal (high-level), Secondary (detailed), Detailed (line-by-line)
- **Expense Types**: "dezvoltare" = capital/development, "functionare" = operational
- **Period Formats**: YEAR="2023", MONTH="2023-01", QUARTER="2023-Q1"
```

---

## 4. Tool Definitions

### Tool 1: `search_data` (Discovery Tool)

**Purpose**: Find machine-readable IDs for entities, UATs, and classifications.

#### Input Schema

```typescript
{
  search_category: 'entity' | 'uat' | 'functional_classification' | 'economic_classification',
  search_term: string,
  limit?: number,      // Max 50, default 10
  offset?: number      // For pagination, default 0
}
```

#### Output Schema

```typescript
{
  ok: boolean,
  kind: string,  // e.g., "entities.search", "uats.search"
  query: {
    search_category: string,
    search_term: string,
    limit: number,
    offset: number
  },
  results: Array<{
    id: string,           // Machine-readable ID for filters
    name: string,         // Human-readable name
    category: string,     // Category type
    context: string,      // Rich contextual information
    metadata?: {          // Category-specific metadata
      // For entities:
      entity_type?: string,
      uat_id?: number,
      uat_name?: string,
      is_uat?: boolean,

      // For UATs:
      uat_code?: string,
      county_code?: string,
      population?: number,
      is_county?: boolean,

      // For classifications:
      code?: string,
      level?: number,
      level_name?: string
    }
  }>,
  pageInfo: {
    totalCount: number,
    limit: number,
    offset: number
  },
  error?: string
}
```

#### Search Categories Explained

| Category | What It Searches | Returns | Use In Filter | Example |
|----------|-----------------|---------|---------------|---------|
| `entity` | Public institutions | CUI (fiscal ID) | `entity_cuis` | Search "Primăria Cluj-Napoca" → CUI → entity_cuis: ["12345678"] |
| `uat` | Geographic areas | Numeric UAT ID | `uat_ids` (as strings!) | Search "Cluj" → 123 → uat_ids: ["123"] |
| `functional_classification` | COFOG3 spending purposes | Functional code | `functional_prefixes` or `functional_codes` | Search "educație" → "70." → functional_prefixes: ["70."] |
| `economic_classification` | Economic spending types | Economic code | `economic_prefixes` or `economic_codes` | Search "salarii" → "20." → economic_prefixes: ["20."] |

#### Search Tips

- **Fuzzy Matching**: Supports Romanian diacritics and similarity search
- **Code Search**: Prefix with "fn:" or "ec:" for explicit code search
  - `"fn:70"` → search functional codes starting with 70
  - `"ec:20.30"` → search economic code 20.30
- **Name Search**: Natural language works
  - `"educație"`, `"educatie"`, `"education"` all work
- **Pagination**: Use `limit` and `offset` for large result sets

#### Context Field Format

**Entity**:

```
"Type: city_hall | Location: Cluj-Napoca | Main Creditor: Consiliul Județean Cluj"
```

**UAT**:

```
"County: CJ | Region: Nord-Vest | Population: 411,379 | Type: County"
```

**Functional Classification**:

```
"COFOG Code: 70. | Level: Chapter"
```

**Economic Classification**:

```
"Economic Code: 20.30 | Level: Paragraph"
```

---

### Tool 2: `generate_chart_data` (Analytics Tool)

**Purpose**: Generate comprehensive budget analytics with visualization.

#### Input Schema

```typescript
{
  title: string,
  description?: string,
  chart_type: 'line' | 'bar' | 'area' | 'pie',
  series_definitions: Array<{
    label: string,
    filter: {
      // REQUIRED FIELDS
      report_period: {
        type: 'YEAR' | 'MONTH' | 'QUARTER',
        selection: {
          interval: { start: string, end: string }
        } | {
          dates: string[]
        }
      },
      account_category: 'ch' | 'vn',

      // ENTITY/GEOGRAPHY FILTERS
      entity_cuis?: string[],           // From search_data(entity)
      uat_ids?: string[],               // From search_data(uat) - MUST BE STRINGS!
      county_codes?: string[],          // e.g., ["CJ", "B", "TM"]
      regions?: string[],               // Development regions
      is_uat?: boolean,                 // Filter to only local government

      // CLASSIFICATION FILTERS
      functional_codes?: string[],      // Exact codes from search_data
      functional_prefixes?: string[],   // Categories (e.g., ["70."])
      economic_codes?: string[],        // Exact codes from search_data
      economic_prefixes?: string[],     // Categories (e.g., ["20."])

      // OTHER DIMENSIONAL FILTERS
      funding_source_ids?: number[],    // Funding source IDs
      budget_sector_ids?: number[],     // Budget sector IDs
      expense_types?: ('dezvoltare' | 'functionare')[],
      program_codes?: string[],         // Program codes

      // NORMALIZATION & AGGREGATION
      normalization?: 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro',
      aggregate_min_amount?: number,    // Filter aggregated totals
      aggregate_max_amount?: number,

      // POPULATION CONSTRAINTS
      min_population?: number,
      max_population?: number,

      // REPORT TYPE
      report_type?: string,  // Default: "Executie bugetara agregata la nivel de ordonator principal"

      // EXCLUSION FILTERS (Advanced)
      exclude?: {
        entity_cuis?: string[],
        functional_codes?: string[],
        functional_prefixes?: string[],
        economic_codes?: string[],
        economic_prefixes?: string[],
        county_codes?: string[],
        uat_ids?: string[]
      }
    }
  }>
}
```

#### Output Schema

```typescript
{
  ok: boolean,
  kind: 'chart-data.generated',
  chart_id: string,
  chart_url: string,
  title: string,
  description?: string,
  data_series: Array<{
    label: string,
    series_id: string,
    x_axis: {
      name: string,     // "Year", "Month", "Quarter"
      type: string,     // "INTEGER", "STRING"
      unit: string      // "year", "month", "quarter"
    },
    y_axis: {
      name: string,     // "Amount"
      type: string,     // "FLOAT"
      unit: string      // "RON", "RON/capita", "EUR", etc.
    },
    data_points: Array<{
      x: string,        // e.g., "2023", "2023-01", "2023-Q1"
      y: number         // Monetary value
    }>,
    statistics?: {
      min: number,      // Minimum value in series
      max: number,      // Maximum value in series
      avg: number,      // Average value
      sum: number,      // Total sum
      count: number     // Number of data points
    }
  }>,
  error?: string
}
```

#### Filter Combinations Guide

**Classification Analysis Patterns:**

```typescript
// All education spending
{ functional_prefixes: ["70."] }

// Specific education subcategory
{ functional_codes: ["70.11.01"] }

// Education excluding higher education
{
  functional_prefixes: ["70."],
  exclude: { functional_codes: ["70.13"] }
}

// Personnel expenses in healthcare
{
  functional_prefixes: ["84."],  // Healthcare
  economic_prefixes: ["20."]     // Personnel
}
```

**Normalization Patterns:**

```typescript
// Comparing different-sized counties - ALWAYS per capita. This should be used on only for uat and counties entities.
{
  uat_ids: ["123"],
  normalization: "per_capita"  // Fair comparison
}

// Absolute amounts for same entity over time in EUR
{
  entity_cuis: ["12345678"],
  normalization: "total_euro"  // Absolute amounts in EUR
}

// International comparison
{
  normalization: "per_capita_euro"  // EUR per person
}
```

---

## 5. Data Model Reference

### Account Categories

| Code | Romanian | English | Use For |
|------|----------|---------|---------|
| `ch` | Cheltuieli | Expenses | Spending analysis |
| `vn` | Venituri | Revenue | Income analysis |

### Normalization Modes

| Mode | Description | When to Use | Output Unit |
|------|-------------|-------------|-------------|
| `total` | Absolute amounts in RON | Same-sized entities, trends | RON |
| `per_capita` | Amount per person in RON | **Comparing counties/cities** | RON/capita |
| `total_euro` | Absolute amounts in EUR | International comparisons | EUR |
| `per_capita_euro` | Amount per person in EUR | International per-capita | EUR/capita |

### Time Granularity

| Type | Format | Example | Use For |
|------|--------|---------|---------|
| `YEAR` | "YYYY" | "2023" | Annual trends, multi-year analysis |
| `MONTH` | "YYYY-MM" | "2023-01" | Seasonal patterns, detailed timing |
| `QUARTER` | "YYYY-QN" | "2023-Q1" | Quarterly reports, mid-range detail |

### Common COFOG3 Codes (Functional)

| Code | Romanian | English | Common Subcodes |
|------|----------|---------|----------------|
| `50.` | Servicii publice generale | General public services | 51. (legislative), 54. (debt) |
| `60.` | Apărare, ordine și siguranță | Defense & public order | 61. (defense), 68. (police) |
| `70.` | **Învățământ** | **Education** | 70.11 (primary), 70.12 (secondary), 70.13 (higher) |
| `80.` | Cultură, religie, sport | Culture, religion, sports | 81. (culture), 83. (sports) |
| `84.` | **Sănătate** | **Healthcare** | 84.10 (hospitals), 84.20 (clinics) |

### Common Economic Codes

| Code | Romanian | English | Includes |
|------|----------|---------|----------|
| `10.` | Venituri | Revenue | Taxes, fees |
| `20.` | **Cheltuieli de personal** | **Personnel expenses** | Salaries, bonuses, social contributions |
| `30.` | **Bunuri și servicii** | **Goods and services** | Utilities, materials, consultancy |
| `40.` | Subvenții | Subsidies | State aid, transfers |
| `50.` | Transferuri | Transfers | Inter-budget transfers |
| `60.` | **Cheltuieli de capital** | **Capital expenses** | Investments, equipment, construction |

### Expense Types

| Type | Romanian | English | Examples |
|------|----------|---------|----------|
| `dezvoltare` | Dezvoltare | Development/Capital | Buildings, infrastructure, equipment |
| `functionare` | Funcționare | Operational/Current | Salaries, utilities, maintenance |

---

## 6. Workflow Examples

### Example 1: Simple County Trend (Romanian Query)

**User Query**: "Arată-mi cheltuielile pentru educație în județul Cluj între 2020 și 2024."

**Agent Workflow**:

1. **Parse Intent**:
   - Metric: expenses (cheltuieli)
   - Category: education (educație)
   - Geography: Cluj County (județul Cluj)
   - Time: 2020-2024
   - Normalization: total (not specified, use default)

2. **Search Phase**:

```javascript
// Step 1: Find functional classification for education
search_data({
  search_category: "functional_classification",
  search_term: "educație"
})
// Returns: { id: "70.", name: "Învățământ", context: "COFOG Code: 70. | Level: Chapter" }

// Step 2: Find UAT for Cluj County
search_data({
  search_category: "uat",
  search_term: "Cluj"
})
// Returns: { id: "123", name: "JUDEȚUL CLUJ", context: "County: CJ | Type: County" }
```

3. **Generate Phase**:

```javascript
generate_chart_data({
  title: "Cheltuieli pentru Educație - Județul Cluj (2020-2024)",
  chart_type: "line",
  series_definitions: [{
    label: "Cluj - Educație",
    filter: {
      report_period: {
        type: "YEAR",
        selection: {
          interval: { start: "2020", end: "2024" }
        }
      },
      account_category: "ch",
      report_type: "Executie bugetara agregata la nivel de ordonator principal",
      uat_ids: ["123"],
      functional_prefixes: ["70."],
      normalization: "total"
    }
  }]
})
```

4. **Analyze Response**:

```javascript
{
  chart_url: "https://example.com/charts/chart-123",
  data_series: [{
    label: "Cluj - Educație",
    data_points: [
      { x: "2020", y: 1500000000 },
      { x: "2021", y: 1600000000 },
      { x: "2022", y: 1750000000 },
      { x: "2023", y: 1850000000 },
      { x: "2024", y: 1950000000 }
    ],
    statistics: {
      min: 1500000000,
      max: 1950000000,
      avg: 1730000000,
      sum: 8650000000,
      count: 5
    }
  }]
}
```

5. **Final Answer to User**:

> "Am analizat cheltuielile pentru educație în județul Cluj din 2020 până în 2024. Se observă o tendință de creștere constantă:
>
> - **2020**: 1.5 miliarde RON
> - **2024**: 1.95 miliarde RON
> - **Creștere totală**: +30% (450 milioane RON)
> - **Creștere medie anuală**: ~7.5%
>
> Puteți vizualiza graficul interactiv aici: [chart_url]"

---

### Example 2: Multi-Series Comparison (English Query)

**User Query**: "Compare per capita personnel expenses for education vs healthcare in București, 2022-2024"

**Agent Workflow**:

1. **Parse Intent**:
   - Metric: expenses (personnel)
   - Categories: education AND healthcare
   - Geography: București
   - Time: 2022-2024
   - Normalization: **per capita** (explicitly requested)
   - Chart type: bar (for comparison)

2. **Search Phase** (4 searches):

```javascript
// Search 1: Economic classification for personnel
search_data({
  search_category: "economic_classification",
  search_term: "personnel"
})
// → { id: "20.", name: "Cheltuieli de personal" }

// Search 2: Functional for education
search_data({
  search_category: "functional_classification",
  search_term: "education"
})
// → { id: "70.", name: "Învățământ" }

// Search 3: Functional for healthcare
search_data({
  search_category: "functional_classification",
  search_term: "health"
})
// → { id: "84.", name: "Sănătate" }

// Search 4: UAT for București
search_data({
  search_category: "uat",
  search_term: "București"
})
// → { id: "456", name: "MUNICIPIUL BUCUREȘTI" }
```

3. **Generate Phase** (2 series):

```javascript
generate_chart_data({
  title: "Personnel Expenses (Per Capita): Education vs Healthcare - București (2022-2024)",
  chart_type: "bar",
  series_definitions: [
    {
      label: "Education - Personnel (Per Capita)",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2022", end: "2024" } }
        },
        account_category: "ch",
        uat_ids: ["456"],
        functional_prefixes: ["70."],
        economic_prefixes: ["20."],
        normalization: "per_capita"
      }
    },
    {
      label: "Healthcare - Personnel (Per Capita)",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2022", end: "2024" } }
        },
        account_category: "ch",
        uat_ids: ["456"],
        functional_prefixes: ["84."],
        economic_prefixes: ["20."],
        normalization: "per_capita"
      }
    }
  ]
})
```

4. **Analyze Response**:

```javascript
{
  data_series: [
    {
      label: "Education - Personnel (Per Capita)",
      data_points: [
        { x: "2022", y: 1250 },
        { x: "2023", y: 1350 },
        { x: "2024", y: 1450 }
      ],
      statistics: { avg: 1350, sum: 4050, min: 1250, max: 1450 }
    },
    {
      label: "Healthcare - Personnel (Per Capita)",
      data_points: [
        { x: "2022", y: 980 },
        { x: "2023", y: 1050 },
        { x: "2024", y: 1120 }
      ],
      statistics: { avg: 1050, sum: 3150, min: 980, max: 1120 }
    }
  ]
}
```

5. **Final Answer**:

> "Here's a comparison of per capita personnel expenses for education and healthcare in București (2022-2024):
>
> **Education Personnel:**
>
> - Average: 1,350 RON/capita
> - Trend: +16% growth (1,250 → 1,450 RON/capita)
>
> **Healthcare Personnel:**
>
> - Average: 1,050 RON/capita
> - Trend: +14% growth (980 → 1,120 RON/capita)
>
> **Key Insights:**
>
> - Education personnel spending is consistently 28-29% higher than healthcare
> - Both sectors show similar growth rates (~15%)
> - Gap remains stable at ~300 RON/capita
>
> View the interactive chart: [chart_url]"

---

### Example 3: Advanced Exclude Filters

**User Query**: "Show me all government spending in Cluj except education, 2023"

**Agent Workflow**:

```javascript
// Search for UAT
search_data({ search_category: "uat", search_term: "Cluj" })
// → { id: "123" }

// Search for education code
search_data({ search_category: "functional_classification", search_term: "educație" })
// → { id: "70." }

// Generate with EXCLUDE filter
generate_chart_data({
  title: "All Spending Except Education - Cluj County (2023)",
  chart_type: "pie",
  series_definitions: [{
    label: "Non-Education Spending",
    filter: {
      report_period: {
        type: "YEAR",
        selection: { dates: ["2023"] }
      },
      account_category: "ch",
      uat_ids: ["123"],
      // KEY: Use exclude to remove education
      exclude: {
        functional_prefixes: ["70."]
      }
    }
  }]
})
```

---

## 7. Advanced Features

### 7.1 Exclude Filters (Negative Matching)

Use the `exclude` object for "everything except X" queries:

```typescript
filter: {
  // Include all counties
  // Exclude București
  exclude: {
    county_codes: ["B"]
  }
}

// Include all spending
// Exclude education AND healthcare
exclude: {
  functional_prefixes: ["70.", "84."]
}

// Include all expense types
// Exclude capital investments
exclude: {
  economic_prefixes: ["60."]
}
```

### 7.2 Population-Based Filtering

Filter entities by population size:

```typescript
// Only large cities (100k+ residents)
filter: {
  min_population: 100000
}

// Only small communes (under 5k)
filter: {
  max_population: 5000
}

// Medium-sized cities (20k-100k)
filter: {
  min_population: 20000,
  max_population: 100000
}
```

### 7.3 Expense Type Analysis

Separate capital vs operational expenses:

```typescript
// Only development/capital expenses (buildings, infrastructure)
filter: {
  expense_types: ["dezvoltare"]
}

// Only operational expenses (salaries, utilities)
filter: {
  expense_types: ["functionare"]
}

// Compare both in separate series
series_definitions: [
  {
    label: "Capital Expenses",
    filter: { expense_types: ["dezvoltare"], ... }
  },
  {
    label: "Operational Expenses",
    filter: { expense_types: ["functionare"], ... }
  }
]
```

### 7.4 Discrete Date Selection

Use specific dates instead of intervals:

```typescript
// Compare Q1 across multiple years
report_period: {
  type: "QUARTER",
  selection: {
    dates: ["2020-Q1", "2021-Q1", "2022-Q1", "2023-Q1", "2024-Q1"]
  }
}

// Specific months only
report_period: {
  type: "MONTH",
  selection: {
    dates: ["2023-01", "2023-06", "2023-12"]  // Jan, Jun, Dec
  }
}
```

### 7.5 Multi-Series Comparison Patterns

**Pattern A: Geographic Comparison**

```typescript
// Compare 3 counties side-by-side
series_definitions: [
  { label: "Cluj", filter: { uat_ids: ["123"], ... } },
  { label: "București", filter: { uat_ids: ["456"], ... } },
  { label: "Timiș", filter: { uat_ids: ["789"], ... } }
]
```

**Pattern B: Category Comparison**

```typescript
// Compare different spending categories
series_definitions: [
  { label: "Education", filter: { functional_prefixes: ["70."], ... } },
  { label: "Healthcare", filter: { functional_prefixes: ["84."], ... } },
  { label: "Infrastructure", filter: { functional_prefixes: ["60."], ... } }
]
```

**Pattern C: Time Comparison**

```typescript
// Compare same metric across different time periods
series_definitions: [
  { label: "2020-2022", filter: { report_period: { interval: { start: "2020", end: "2022" } }, ... } },
  { label: "2023-2024", filter: { report_period: { interval: { start: "2023", end: "2024" } }, ... } }
]
```

---

## 8. Implementation Details

### 8.1 Technical Architecture

**File Structure**:

```
src/
├── mcp/
│   └── server.ts           # MCP tool definitions (search_data, generate_chart_data)
├── services/
│   └── ai-basic.ts         # Search functions (entities, UATs, classifications)
├── db/repositories/
│   ├── entityRepository.ts
│   ├── uatRepository.ts
│   ├── functionalClassificationRepository.ts
│   ├── economicClassificationRepository.ts
│   └── executionLineItemRepository.ts  # Analytics queries
└── types.ts                # AnalyticsFilter interface
```

**Data Flow**:

```
MCP Tool Call
    ↓
Zod Validation
    ↓
Service Layer (ai-basic.ts)
    ↓
Repository Layer (pg_trgm search / analytics query)
    ↓
PostgreSQL Database (partitioned by year & report_type)
    ↓
Response Formatting
    ↓
MCP Tool Response
```

### 8.2 Search Implementation

**Technology**:

- **PostgreSQL Extension**: `pg_trgm` (trigram similarity)
- **Threshold**: 0.1 (tuned for Romanian short strings)
- **Diacritics**: Full support (ă, â, î, ș, ț)

**Search Modes**:

1. **Code Mode** (functional/economic):
   - Prefix: `fn:70` or `ec:20`
   - Pattern: Starts with code
   - Example: `fn:70.11` → finds 70.11.01, 70.11.02, etc.

2. **Name Mode** (all categories):
   - Fuzzy matching with ILIKE + similarity
   - Example: `"educatie"` → matches "Învățământ"

3. **Relevance Ranking**:
   - Exact prefix match (highest)
   - Similarity score (desc)
   - Code/ID (asc, for ties)

### 8.3 Analytics Implementation

**Query Execution**:

```typescript
// Monthly trend
executionLineItemRepository.getMonthlyTrend(filter)
// → Array<{ year, month, value }>

// Quarterly trend
executionLineItemRepository.getQuarterlyTrend(filter)
// → Array<{ year, quarter, value }>

// Yearly trend
executionLineItemRepository.getYearlyTrend(filter)
// → Array<{ year, value }>
```

**Normalization**:

```typescript
getNormalizationUnit(normalization)
// "total"          → "RON"
// "per_capita"     → "RON/capita"
// "total_euro"     → "EUR"
// "per_capita_euro" → "EUR/capita"
```

**Statistics Calculation**:

```typescript
{
  min: Math.min(...values),
  max: Math.max(...values),
  avg: sum / count,
  sum: values.reduce((a, b) => a + b, 0),
  count: values.length
}
```

### 8.4 UAT ID Conversion

**Critical Detail**: UAT IDs are stored as `INTEGER` in the database but MUST be passed as `STRING` in MCP filters.

```typescript
// ✅ CORRECT
{
  uat_ids: ["123", "456", "789"]
}

// ❌ WRONG - will cause errors
{
  uat_ids: [123, 456, 789]
}
```

**Internal Conversion**:

```typescript
// MCP tool converts strings to numbers before querying
uat_ids: seriesDef.filter.uat_ids?.map(id => parseInt(id, 10))
```

### 8.5 Performance Considerations

**Caching**:

- Entity cache: 50K items, 5MB max
- Analytics cache: 20K items
- Classification cache: 5K items

**Partitioning**:

- Table: `ExecutionLineItems`
- Partition key: `year` (RANGE) → `report_type` (LIST)
- Enables partition pruning for fast queries

**Indexing**:

- GIN index on entity/UAT names for trigram search
- B-tree indexes on codes (functional, economic)
- Composite indexes on common filter combinations

### 8.6 Error Handling

**Validation Errors**:

```typescript
// Missing required field
{
  ok: false,
  error: "report_period is required"
}

// Invalid UAT ID format
{
  ok: false,
  error: "uat_ids must be an array of strings"
}
```

**Data Errors**:

```typescript
// No results found
{
  ok: true,
  data_series: [{
    data_points: [],
    statistics: { min: 0, max: 0, avg: 0, sum: 0, count: 0 }
  }]
}
```

### 8.7 Chart URL Generation

```typescript
const chartUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/charts/${chartId}`;
```

**Chart ID Format**:

```
chart-{timestamp}-{random}
// Example: chart-1706270400000-k3j8h2
```

---

## Appendix A: Quick Reference

### Common Query Patterns Cheatsheet

| User Intent | Search Categories | Filter Fields | Normalization |
|-------------|------------------|---------------|---------------|
| "Spending in Cluj County" | uat: "Cluj" | uat_ids | per_capita (if comparing) |
| "Education spending" | functional: "educație" | functional_prefixes: ["70."] | total or per_capita |
| "Salaries for teachers" | functional: "educație"<br>economic: "salarii" | functional_prefixes: ["70."]<br>economic_prefixes: ["20."] | total |
| "City hall budget" | entity: "Primăria X" | entity_cuis | total |
| "National healthcare" | functional: "sănătate" | functional_prefixes: ["84."]<br>(no uat_ids) | total |
| "All except education" | functional: "educație" | exclude: { functional_prefixes: ["70."] } | varies |

### Filter Field Decision Tree

```
Need to filter by...

WHAT is being spent?
├─ Broad category? → functional_prefixes: ["70."]
└─ Specific item? → functional_codes: ["70.11.01"]

HOW is being spent?
├─ Broad type? → economic_prefixes: ["20."]
└─ Specific line? → economic_codes: ["20.30.01"]

WHERE?
├─ Geographic area? → uat_ids (from UAT search)
├─ Specific institution? → entity_cuis (from entity search)
├─ County-level? → county_codes: ["CJ"]
└─ Region-level? → regions: ["Nord-Vest"]

WHEN?
├─ Annual data? → type: "YEAR"
├─ Monthly data? → type: "MONTH"
└─ Quarterly data? → type: "QUARTER"

HOW to normalize?
├─ Different-sized areas? → "per_capita"
├─ Same entity over time? → "total"
└─ International comparison? → "*_euro"
```
