# Chart Schema System - Comprehensive Guide for AI Agents

This document provides a complete reference for constructing charts using the Transparenta.eu chart schema system. It is designed for AI agents and developers who need to programmatically create data visualizations for analyzing Romanian public budget data.

## Table of Contents

1. [System Overview](#system-overview)
2. [Chart Schema Structure](#chart-schema-structure)
3. [Chart Types](#chart-types)
4. [Series Types](#series-types)
5. [Analytics Filter Schema](#analytics-filter-schema)
6. [Field Reference Guide](#field-reference-guide)
7. [Period Handling](#period-handling)
8. [Classification System](#classification-system)
9. [Data Calculations](#data-calculations)
10. [Best Practices](#best-practices)
11. [Complete Examples](#complete-examples)

---

## System Overview

### Architecture

The chart system follows a declarative schema-based approach where charts are defined by:

1. **Chart Configuration** - Global settings (type, colors, legend, etc.)
2. **Series Definitions** - Multiple data series with individual filters
3. **Annotations** - Optional manual annotations for context
4. **Metadata** - Title, description, timestamps

### Data Flow

```
Chart Schema → Analytics API → GraphQL Backend → Data Processing → Visualization
     ↓              ↓                                      ↓
   Filters    Transform filters              Calculate/aggregate series
                to GraphQL                    Apply normalizations
```

### Key Components

- **Chart**: The root object containing all configuration
- **Series**: Individual data series with filters and configuration
- **AnalyticsFilter**: The filter object that controls what data is fetched
- **ChartConfig**: Global chart visualization settings
- **SeriesConfig**: Per-series visualization overrides

---

## Chart Schema Structure

### Root Chart Object

```typescript
interface Chart {
  id: string;                      // UUID - unique chart identifier
  title: string;                   // Chart title
  description?: string;            // Optional description
  config: ChartConfig;             // Global chart configuration
  series: Series[];                // Array of data series
  annotations: Annotation[];       // Manual annotations
  createdAt: string;              // ISO 8601 timestamp
  updatedAt: string;              // ISO 8601 timestamp
}
```

### Chart Configuration

```typescript
interface ChartConfig {
  chartType: 'line' | 'bar' | 'area' | 'bar-aggr' | 'pie-aggr' | 'treemap-aggr' | 'sankey-aggr';
  color: string;                   // Default hex color (e.g., '#0062ff')
  showDataLabels?: boolean;        // Show data labels on chart for all series
  showGridLines: boolean;          // Display grid lines (default: true)
  showLegend: boolean;             // Display legend (default: true)
  showRelativeValues?: boolean;    // Show as percentages relative to first series
  showTooltip: boolean;            // Show tooltips on hover (default: true)
  showDiffControl?: boolean;       // Show range selector for difference calculation
  editAnnotations: boolean;        // Allow annotation editing (default: true)
  showAnnotations: boolean;        // Display annotations (default: true)
  yearRange?: {                    // Optional year range filter
    start?: number;                // Start year (e.g., 2016)
    end?: number;                  // End year (e.g., 2025)
  };
}
```

**Important Notes:**

- `showRelativeValues`: When enabled, displays all series as percentages relative to the first series. The first series value becomes 100%, and other series are calculated proportionally.
- `yearRange`: Applies only to time-series charts, filters the x-axis to show data within this range.

---

## Chart Types

### Available Chart Types

| Type | Description | Use Case | Data Structure |
|------|-------------|----------|----------------|
| `line` | Line chart | Time-series trends, comparisons over time | Time-series data |
| `bar` | Vertical bar chart | Time-series comparisons, categorical data | Time-series data |
| `area` | Area chart | Time-series with emphasis on magnitude | Time-series data |
| `bar-aggr` | Aggregated bar chart | Single-period comparisons across series | Aggregated data |
| `pie-aggr` | Pie chart | Proportional breakdown of aggregated totals | Aggregated data |
| `treemap-aggr` | Treemap | Hierarchical breakdown of aggregated data | Aggregated data |
| `sankey-aggr` | Sankey diagram | Flow visualization between categories | Aggregated data |

### Time-Series vs Aggregated Charts

**Time-Series Charts** (`line`, `bar`, `area`):

- Display data points across multiple time periods (years, months, quarters)
- Each series shows values over time
- X-axis represents time periods
- Y-axis represents aggregated amounts

**Aggregated Charts** (`bar-aggr`, `pie-aggr`, `treemap-aggr`, `sankey-aggr`):

- Display single aggregated value per series
- Each series represents a category or filter combination
- No time dimension on display
- Show proportions or absolute values for a specific period

---

## Series Types

The system supports 5 distinct series types, each serving a different purpose:

### 1. `line-items-aggregated-yearly` (Primary Data Series)

This is the main series type that fetches real data from the backend API based on analytics filters.

```typescript
interface SeriesConfiguration {
  id: string;                      // UUID
  type: 'line-items-aggregated-yearly';
  enabled: boolean;                // Whether series is active (default: true)
  label: string;                   // Display label for the series
  unit: string;                    // Unit from API (e.g., 'RON', 'EUR')
  filter: AnalyticsFilterType;     // The filter defining what data to fetch
  config: SeriesConfig;            // Visual configuration overrides
  createdAt: string;              // ISO 8601 timestamp
  updatedAt: string;              // ISO 8601 timestamp
}
```

**Key Points:**

- Fetches data via GraphQL `executionAnalytics` query
- Filter determines what subset of budget data is retrieved
- Data is aggregated by the backend based on period selection
- Unit is determined by the API response and normalization settings

**Example Use Cases:**

- Total spending for education sector over 2016-2025
- Revenue from a specific county
- Specific entity's budget execution
- Development expenses for infrastructure

### 2. `aggregated-series-calculation` (Computed Series)

Creates new series by performing mathematical operations on existing series.

```typescript
interface SeriesGroupConfiguration {
  id: string;
  type: 'aggregated-series-calculation';
  enabled: boolean;
  label: string;
  unit: string;                    // Unit for the calculated result
  calculation: Calculation;        // The calculation to perform
  config: SeriesConfig;
  createdAt: string;
  updatedAt: string;
}

interface Calculation {
  op: 'sum' | 'subtract' | 'multiply' | 'divide';
  args: Array<string | Calculation | number>; // Series IDs, nested calcs, or constants
}
```

**Operations:**

- `sum`: Add multiple series or values together
- `subtract`: Subtract subsequent operands from the first
- `multiply`: Multiply series or values
- `divide`: Divide first operand by subsequent operands

**Key Points:**

- Arguments can be series IDs, numbers, or nested calculations
- System validates against circular dependencies
- Data points are aligned by x-axis value (year/month/quarter)
- Missing data points default to 0 for sum/subtract, excluded for multiply/divide
- Division by zero returns null (point removed from result)

**Example Use Cases:**

- Budget deficit: `subtract([revenueSeriesId, expensesSeriesId])`
- Average of multiple entities: `divide([sum([entity1, entity2, entity3]), 3])`
- Growth rate: `divide([currentYear, previousYear])`
- Total budget: `sum([developmentBudget, operationalBudget])`

### 3. `custom-series` (User-Defined Data)

Allows manual entry of data points for custom analysis.

```typescript
interface CustomSeriesConfiguration {
  id: string;
  type: 'custom-series';
  enabled: boolean;
  label: string;
  unit: string;                    // User-defined unit
  data: Array<{
    year: number;                  // Year (e.g., 2020)
    value: number;                 // Value for that year
  }>;
  config: SeriesConfig;
  createdAt: string;
  updatedAt: string;
}
```

**Key Points:**

- Data array spans default year range (2016-2025)
- Missing years default to value 1
- Useful for overlaying external data sources
- Can be used as input to calculations

**Example Use Cases:**

- Overlaying inflation rates
- Population growth trends
- Economic indicators (GDP, unemployment)
- Targets or projections

### 4. `custom-series-value` (Constant Value)

Creates a flat line at a constant value across all years.

```typescript
interface CustomSeriesValueConfiguration {
  id: string;
  type: 'custom-series-value';
  enabled: boolean;
  label: string;
  unit: string;
  value: number;                   // Constant value
  config: SeriesConfig;
  createdAt: string;
  updatedAt: string;
}
```

**Key Points:**

- Same value for every time period
- Useful for reference lines
- Can be used in calculations (e.g., as a divisor for normalization)

**Example Use Cases:**

- Threshold lines (e.g., budget cap)
- Baseline for comparisons
- Normalization factors

### 5. `static-series` (Predefined Datasets)

References predefined datasets stored on the server (e.g., macroeconomic indicators).

```typescript
interface StaticSeriesConfiguration {
  id: string;
  type: 'static-series';
  enabled: boolean;
  label: string;
  unit?: string;                   // Optional override for server unit
  seriesId?: string;               // Server dataset ID
  config: SeriesConfig;
  createdAt: string;
  updatedAt: string;
}
```

**Key Points:**

- Data is fetched via `staticChartAnalytics` GraphQL query
- Server provides predefined datasets (GDP, inflation, population, etc.)
- Supports localization (Romanian/English)
- Unit can be overridden locally

**Example Use Cases:**

- National GDP trend
- Inflation rates
- Population statistics
- Exchange rates

### Series Visual Configuration

All series types share a common `SeriesConfig`:

```typescript
interface SeriesConfig {
  visible: boolean;                // Show on chart (default: true)
  showDataLabels: boolean;         // Show data point labels (default: false)
  dataLabels?: string[];           // Specific labels for x-axis points
  dataLabelOffset?: number;        // Offset from x-axis
  color: string;                   // Hex color (default: '#0000ff')
  xAxisPrefixToRemove?: string;    // Strip prefix from x-axis labels (for alignment)
}
```

**Important:**

- `visible: false` hides the series but still includes it in calculations if referenced
- `xAxisPrefixToRemove`: Useful when aligning monthly data (e.g., "2023-") with yearly data

---

## Analytics Filter Schema

The `AnalyticsFilterType` is the heart of the data query system. It defines what subset of budget data to retrieve.

### Complete Filter Structure

```typescript
interface AnalyticsFilterType {
  // === REQUIRED/PRIMARY FILTERS ===
  report_period?: ReportPeriodInput;     // Period selector (YEAR/MONTH/QUARTER)
  account_category: 'ch' | 'vn';         // 'ch' = expenses, 'vn' = revenues

  // === DIMENSIONAL FILTERS ===
  report_type?: ReportType;              // Budget report aggregation level
  report_ids?: string[];                 // Specific report IDs
  main_creditor_cui?: string;            // Main creditor taxpayer ID
  reporting_years?: number[];            // Specific years (deprecated, use report_period)

  // === ENTITY FILTERS ===
  entity_cuis?: string[];                // Public entity taxpayer IDs
  entity_types?: string[];               // Entity types (e.g., 'UAT', 'Ministerul')
  is_uat?: boolean;                      // Filter to UAT entities only

  // === GEOGRAPHIC FILTERS ===
  county_codes?: string[];               // County codes (e.g., ['AB', 'IF'])
  regions?: string[];                    // Development regions
  uat_ids?: string[];                    // Administrative unit IDs

  // === CLASSIFICATION FILTERS ===
  functional_codes?: string[];           // Full functional classification codes
  functional_prefixes?: string[];        // Functional classification prefixes
  economic_codes?: string[];             // Full economic classification codes
  economic_prefixes?: string[];          // Economic classification prefixes

  // === BUDGET DIMENSION FILTERS ===
  funding_source_ids?: string[];         // Funding source IDs
  budget_sector_ids?: string[];          // Budget sector IDs
  expense_types?: Array<'dezvoltare' | 'functionare'>; // Development vs operational
  program_codes?: string[];              // Program codes

  // === AMOUNT FILTERS ===
  aggregate_min_amount?: number | string; // Minimum aggregated total
  aggregate_max_amount?: number | string; // Maximum aggregated total
  item_min_amount?: number | string;      // Minimum per-item amount
  item_max_amount?: number | string;      // Maximum per-item amount

  // === POPULATION FILTERS ===
  min_population?: number;               // Minimum entity population
  max_population?: number;               // Maximum entity population

  // === DATA TRANSFORMATION ===
  normalization?: 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro';

  // === TEXT SEARCH ===
  search?: string;                       // Free-text search

  // === EXCLUDE FILTERS (NEGATIVE FILTERING) ===
  exclude?: {
    report_ids?: string[];
    entity_cuis?: string[];
    main_creditor_cui?: string;
    functional_codes?: string[];
    functional_prefixes?: string[];
    economic_codes?: string[];
    economic_prefixes?: string[];
    funding_source_ids?: string[];
    budget_sector_ids?: string[];
    expense_types?: Array<'dezvoltare' | 'functionare'>;
    program_codes?: string[];
    county_codes?: string[];
    regions?: string[];
    uat_ids?: string[];
    entity_types?: string[];
  };
}
```

### Filter Logic

- **Include Filters**: Most filters act as AND logic (must match all specified criteria)
- **Array Filters**: Within an array, it's OR logic (match any of the values)
- **Exclude Filters**: Items matching exclude criteria are removed from results
- **Prefix Filters**: Match all codes starting with the prefix (e.g., `"70."` matches `"70.01.01"`, `"70.02"`, etc.)

---

## Field Reference Guide

### 1. `report_period` (Period Selection)

The most important filter defining the time dimension of your data.

#### Structure

```typescript
interface ReportPeriodInput {
  type: 'YEAR' | 'MONTH' | 'QUARTER';
  selection: {
    interval?: { start: PeriodDate; end: PeriodDate };
    dates?: PeriodDate[];
  };
}

// PeriodDate examples:
// - Year: "2023"
// - Month: "2023-05"
// - Quarter: "2023-Q2"
```

#### Selection Modes

**Interval Mode** - Contiguous range:

```typescript
{
  type: 'YEAR',
  selection: { interval: { start: '2016', end: '2025' } }
}
```

**Dates Mode** - Specific non-contiguous periods:

```typescript
{
  type: 'MONTH',
  selection: { dates: ['2023-01', '2023-06', '2023-12'] }
}
```

#### Period Types

| Type | Format | Example | Use Case |
|------|--------|---------|----------|
| `YEAR` | `YYYY` | `"2023"` | Annual trends, multi-year analysis |
| `MONTH` | `YYYY-MM` | `"2023-05"` | Monthly breakdown within a year |
| `QUARTER` | `YYYY-Qn` | `"2023-Q2"` | Quarterly analysis |

#### Important Notes

- **Default Period**: If not specified, defaults to current year
- **Time-Series Charts**: Use intervals for continuous trends
- **Aggregated Charts**: Can use single date or aggregate across interval
- **Data Alignment**: The backend returns data points matching the period type
- **Cross-Period Analysis**: You can have monthly series and yearly series in the same chart (use `xAxisPrefixToRemove` to align labels)

#### Examples

**Annual trend 2016-2025:**

```typescript
report_period: {
  type: 'YEAR',
  selection: { interval: { start: '2016', end: '2025' } }
}
```

**Specific quarters in 2023:**

```typescript
report_period: {
  type: 'QUARTER',
  selection: { dates: ['2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4'] }
}
```

**Monthly data for first half of 2024:**

```typescript
report_period: {
  type: 'MONTH',
  selection: { interval: { start: '2024-01', end: '2024-06' } }
}
```

**Single year (for aggregated charts):**

```typescript
report_period: {
  type: 'YEAR',
  selection: { interval: { start: '2023', end: '2023' } }
}
```

---

### 2. `account_category` (Revenue vs Expenses)

Controls whether you're analyzing spending or revenue.

```typescript
account_category: 'ch' | 'vn'  // Required field, default: 'ch'
```

- `'ch'` (Cheltuieli) = **Expenses/Spending**
- `'vn'` (Venituri) = **Revenues/Income**

**Use Cases:**

- **Budget Analysis**: Use `'ch'` for expense tracking
- **Revenue Analysis**: Use `'vn'` for income sources
- **Deficit Calculation**: Create two series (one with each category) and subtract

---

### 3. `report_type` (Budget Report Level)

Defines the aggregation level of budget reports.

```typescript
type ReportType =
  | 'Executie bugetara agregata la nivel de ordonator principal'
  | 'Executie bugetara agregata la nivel de ordonator secundar'
  | 'Executie bugetara detaliata'
```

**Report Types:**

| Type | GraphQL Enum | Description | Data Granularity |
|------|--------------|-------------|------------------|
| Principal Aggregated | `PRINCIPAL_AGGREGATED` | Aggregated at principal budget holder level | High-level |
| Secondary Aggregated | `SECONDARY_AGGREGATED` | Aggregated at secondary budget holder level | Medium |
| Detailed | `DETAILED` | Detailed line items | Granular |

**Usage Guidelines:**

- **Overview Analysis**: Use `PRINCIPAL_AGGREGATED` for high-level trends
- **Departmental Analysis**: Use `SECONDARY_AGGREGATED` for department-level data
- **Granular Investigation**: Use `DETAILED` for specific line items (may be slower)

---

### 4. Entity Filters

#### `entity_cuis` (Public Entity IDs)

Array of CUI/CIF taxpayer identification numbers.

```typescript
entity_cuis: string[]  // e.g., ['12345678', '87654321']
```

**Format:** Romanian taxpayer IDs (CUI/CIF)

**Use Cases:**

- Compare specific entities (e.g., multiple municipalities)
- Track single entity over time
- Aggregate spending across a group of entities

#### `main_creditor_cui` (Main Creditor)

Single taxpayer ID for the main creditor.

```typescript
main_creditor_cui: string  // e.g., '12345678'
```

**Use Cases:**

- Filter by main budget holder
- Analyze centralized vs decentralized spending

#### `entity_types` (Entity Categories)

```typescript
entity_types: string[]  // e.g., ['admin_municipality', 'admin_ministry']
```

---

### 5. Geographic Filters

#### `county_codes` (Counties)

```typescript
county_codes: string[]  // e.g., ['AB', 'B', 'CJ', 'IF']
```

**Format:** Two-letter county codes (Romanian standard)

**Common Codes:**

- `'B'` - București
- `'IF'` - Ilfov
- `'CJ'` - Cluj
- `'AB'` - Alba
- etc.

#### `regions` (Development Regions) Not implemented yet

```typescript
regions: string[]  // e.g., ['Centru', 'Nord-Vest']
```

**Romanian Development Regions:**

- `'Nord-Est'`
- `'Sud-Est'`
- `'Sud-Muntenia'`
- `'Sud-Vest Oltenia'`
- `'Vest'`
- `'Nord-Vest'`
- `'Centru'`
- `'București-Ilfov'`

#### `uat_ids` (Administrative Units)

```typescript
uat_ids: string[]  // Specific UAT identifiers
```

**Use Cases:**

- Municipality-level analysis
- Commune comparisons
- City budget tracking

#### `is_uat` (UAT Filter Flag)

```typescript
is_uat: boolean
```

- `true` - Only UAT entities
- `false` - Exclude UAT entities
- `undefined` - No filtering

---

### 6. Classification Filters

Romanian budget data uses two classification systems: **Functional** (COFOG-based) and **Economic**.

#### Functional Classifications

##### `functional_codes` (Full Codes)

```typescript
functional_codes: string[]  // e.g., ['70.01.01', '80.02']
```

**Format:** Hierarchical dot-notation codes (Romanian COFOG3)

**Structure:**

- Level 1: `"70"` - Major function (e.g., Education)
- Level 2: `"70.01"` - Sub-function (e.g., Pre-primary education)
- Level 3: `"70.01.01"` - Detailed function

**Common Functional Areas:**

- `"65"` - Education
- `"66"` - Health
- `"51"` - Public authorities and external actions
- `"68"` - Social protection
- `"55"` - Transactions regarding public debt and loans

**Use Cases:**

- Analyze specific programs (e.g., all health spending)
- Compare similar functions across entities
- Track functional allocation over time

##### `functional_prefixes` (Prefix Matching)

```typescript
functional_prefixes: string[]  // e.g., ['65.', '65.04']
```

**Behavior:** Matches all codes starting with the prefix

**Examples:**

- `'65.'` → matches `"65.01"`, `"65.01.01"`, `"65.02"`, etc. (ALL education)
- `'65.03'` → matches `"65.03.01"`, `"65.03.02"`, etc. (pre-primary education)

**Use Cases:**

- Aggregate all spending in a functional area
- Hierarchical drill-down in treemaps
- Category-level comparisons

#### Economic Classifications

##### `economic_codes` (Full Codes)

```typescript
economic_codes: string[]  // e.g., ['10.01.01', '20.01']
```

**Format:** Hierarchical dot-notation (Romanian standard)

**Structure:**

- Chapter: `"10"` - Personnel expenses
- Subchapter: `"10.01"` - Salaries
- Article: `"10.01.01"` - Base salary

**Common Economic Categories:**

- `"10"` - Personnel expenses
- `"20"` - Material and service expenses
- `"30"` - Interest
- `"40"` - Subsidies
- `"50"` - Transfers

##### `economic_prefixes` (Prefix Matching)

```typescript
economic_prefixes: string[]  // e.g., ['10.', '20.']
```

**Behavior:** Same as functional prefixes - matches all codes with that prefix

---

### 7. Budget Dimension Filters

#### `budget_sector_ids` (Budget Sectors)

```typescript
budget_sector_ids: string[]
```

**Examples:**

- Education sector
- Health sector
- Infrastructure sector

#### `funding_source_ids` (Funding Sources)

```typescript
funding_source_ids: string[]
```

**Examples:**

- State budget
- EU funds
- Own revenues
- Loans

#### `expense_types` (Development vs Operational)

```typescript
expense_types: Array<'dezvoltare' | 'functionare'>
```

- `'dezvoltare'` - **Development/Capital** expenses (investments, infrastructure)
- `'functionare'` - **Operational** expenses (salaries, utilities, maintenance)

**Use Cases:**

- Compare development vs operational spending
- Track investment trends
- Analyze operational efficiency

#### `program_codes` (Budget Programs)

```typescript
program_codes: string[]
```

**Use Cases:**

- Track specific government programs
- Multi-year program analysis

---

### 8. Amount and Population Filters

#### Aggregate Amount Filters

```typescript
aggregate_min_amount?: number | string;  // Minimum total across period
aggregate_max_amount?: number | string;  // Maximum total across period
```

**Use Cases:**

- Filter entities with spending above threshold
- Focus on significant budget items
- Exclude very small amounts

**Example:**

```typescript
{
  aggregate_min_amount: 1000000,  // Only entities with >1M RON total
  aggregate_max_amount: 50000000  // And <50M RON total
}
```

#### Item Amount Filters

```typescript
item_min_amount?: number | string;  // Minimum per line item
item_max_amount?: number | string;  // Maximum per line item
```

**Use Cases:**

- Filter individual transactions
- Identify large purchases
- Exclude micro-transactions

#### Population Filters

```typescript
min_population?: number;  // Minimum entity population
max_population?: number;  // Maximum entity population
```

**Use Cases:**

- Compare similarly-sized municipalities
- Per capita analysis for specific population ranges
- Urban vs rural comparisons

**Example:**

```typescript
{
  min_population: 50000,   // Cities with 50k+ population
  max_population: 500000   // But under 500k
}
```

---

### 9. `normalization` (Data Transformation)

Controls how monetary values are presented.

```typescript
normalization?: 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro'
```

| Value | Description | Unit | Use Case |
|-------|-------------|------|----------|
| `'total'` | Raw totals | RON | Absolute amounts, large budgets |
| `'per_capita'` | Per person | RON/capita | Fair comparisons between different-sized entities |
| `'total_euro'` | Euro converted | EUR | International comparisons |
| `'per_capita_euro'` | Euro per person | EUR/capita | International per capita comparisons |

**Important Notes:**

- Per capita calculations use entity population data
- Euro conversion uses exchange rates from the data period
- Normalization is applied by the backend before data is returned

**Best Practices:**

- Use `per_capita` when comparing entities of different sizes
- Use `total` for absolute budget tracking
- Use `total_euro` for EU fund analysis or international context

---

### 10. Exclude Filters

The `exclude` object mirrors most include filters but with negative logic.

```typescript
exclude?: {
  entity_cuis?: string[];
  functional_codes?: string[];
  economic_codes?: string[];
  // ... same fields as include filters
}
```

**Use Cases:**

- Remove outliers from analysis
- Exclude specific problematic entities
- Filter out specific budget categories
- "Everything except X" queries

**Example:**

```typescript
{
  functional_prefixes: ['70.'],  // All education spending
  exclude: {
    functional_codes: ['70.05']  // EXCEPT higher education
  }
}
```

**Execution Order:**

1. Include filters select initial dataset
2. Exclude filters remove items from that set

---

## Period Handling

### Period Granularity

The system supports three period granularities with automatic aggregation:

#### YEAR Mode

- **Format:** `"YYYY"`
- **Aggregation:** Sums all data within each calendar year
- **Best For:** Multi-year trends, annual budgets
- **X-Axis Labels:** Year numbers (2020, 2021, ...)

#### MONTH Mode

- **Format:** `"YYYY-MM"`
- **Aggregation:** Sums all data within each month
- **Best For:** Seasonal analysis, monthly execution tracking
- **X-Axis Labels:** Year-month (2023-01, 2023-02, ...)

#### QUARTER Mode

- **Format:** `"YYYY-Qn"`
- **Aggregation:** Sums all data within each quarter
- **Best For:** Quarterly reporting, seasonal trends
- **X-Axis Labels:** Year-quarter (2023-Q1, 2023-Q2, ...)

### Period Selection Patterns

#### Pattern 1: Full Trend (Interval)

```typescript
{
  type: 'YEAR',
  selection: { interval: { start: '2016', end: '2025' } }
}
```

**Result:** Continuous line from 2016 to 2025

#### Pattern 2: Specific Points (Dates)

```typescript
{
  type: 'YEAR',
  selection: { dates: ['2016', '2018', '2020', '2022', '2024'] }
}
```

**Result:** Only those specific years, gaps on x-axis

#### Pattern 3: Single Period (Aggregated Charts)

```typescript
{
  type: 'YEAR',
  selection: { interval: { start: '2024', end: '2024' } }
}
```

**Result:** Single aggregated value for 2024

#### Pattern 4: Monthly Within Year

```typescript
{
  type: 'MONTH',
  selection: { interval: { start: '2024-01', end: '2024-12' } }
}
```

**Result:** 12 data points for each month of 2024

### Period Best Practices

1. **Time-Series Charts**: Use intervals for continuous x-axis
2. **Comparison Charts**: Use dates mode for specific points
3. **Year-over-Year**: Create separate series with different year intervals
4. **Month-over-Month**: Use MONTH type with interval within a year
5. **Cross-Granularity**: You can mix yearly and monthly series, but use `xAxisPrefixToRemove` in SeriesConfig to align labels

---

## Classification System

### Functional Classifications (COFOG-based)

Romanian public spending is classified by **function** using a COFOG-derived hierarchical system.

#### Hierarchy Levels

```
Level 1 (Division): 70      - Education
Level 2 (Group):    70.01   - Pre-primary and primary education
Level 3 (Class):    70.01.01 - Pre-primary education
```

#### Major Functional Divisions

| Code Prefix | Function | Common Subcategories |
|-------------|----------|---------------------|
| `01.xx` | General public services | Administration, foreign affairs |
| `02.xx` | Defense | Military, civil protection |
| `03.xx` | Public order and safety | Police, courts, prisons |
| `04.xx` | Economic affairs | Transport, agriculture, industry |
| `05.xx` | Environmental protection | Waste, pollution, nature |
| `06.xx` | Housing and community | Urban development, water supply |
| `07.xx` | Health | Hospitals, outpatient, public health |
| `08.xx` | Recreation, culture, religion | Sports, culture, media |
| `09.xx` | Education | All education levels |
| `10.xx` | Social protection | Pensions, family support, unemployment |

#### Using Functional Codes vs Prefixes

**Exact Codes** (`functional_codes`):

- Specific programs: `['70.01.01']` = Only pre-primary education
- Multiple specific items: `['70.01.01', '70.01.02', '80.01.01']`

**Prefixes** (`functional_prefixes`):

- Entire division: `['70.']` = ALL education spending
- Specific group: `['70.01']` = All pre-primary and primary education
- Multiple categories: `['70.', '80.']` = Education AND health

**Hierarchical Drill-Down Example:**

```typescript
// Level 1: All education
{ functional_prefixes: ['70.'] }

// Level 2: Drill down to primary/secondary
{ functional_prefixes: ['70.01'] }

// Level 3: Specific to pre-primary
{ functional_codes: ['70.01.01'] }
```

---

### Economic Classifications

Budget items are also classified by **economic nature** (what the money is spent on).

#### Hierarchy Levels

```
Chapter:    10         - Personnel expenses
Subchapter: 10.01      - Salaries
Article:    10.01.01   - Base salaries
Paragraph:  10.01.01.01 - Base salaries for civil servants
```

#### Major Economic Chapters

| Code Prefix | Category | Examples |
|-------------|----------|----------|
| `10.xx` | Personnel expenses | Salaries, bonuses, contributions |
| `20.xx` | Material & service | Utilities, maintenance, supplies |
| `30.xx` | Interest | Debt service |
| `40.xx` | Subsidies | Support to enterprises |
| `50.xx` | Transfers | Between government levels |
| `55.xx` | Other transfers | Social benefits |
| `70.xx` | Capital expenses | Buildings, equipment, infrastructure |
| `80.xx` | Loans granted | Financial operations |
| `81.xx` | Loan repayments | Principal repayments |

#### Personnel vs Non-Personnel Analysis

```typescript
// Personnel costs
{
  economic_prefixes: ['10.']
}

// Non-personnel operational costs
{
  economic_prefixes: ['20.', '30.']
}

// Capital investments
{
  economic_prefixes: ['70.']
}
```

#### Development vs Operational (Alternative View)

The `expense_types` filter provides a higher-level categorization:

```typescript
// Development/capital expenses (investments)
{
  expense_types: ['dezvoltare']
}

// Operational expenses (day-to-day)
{
  expense_types: ['functionare']
}
```

**Relationship:**

- `'dezvoltare'` roughly corresponds to economic chapter `70.xx`
- `'functionare'` roughly corresponds to chapters `10.xx`, `20.xx`, `30.xx`, etc.

---

## Data Calculations

### Calculation Operations

The `aggregated-series-calculation` type supports four operations:

#### 1. SUM

Adds all operands together.

```typescript
{
  op: 'sum',
  args: ['series1Id', 'series2Id', 'series3Id']
}
```

**Use Cases:**

- Total budget from multiple sources
- Aggregate multiple entities
- Combine functional categories

**Behavior:**

- Missing data points default to 0
- Result is sum of all available values per time period

**Example:**

```typescript
// Total education + health spending
{
  op: 'sum',
  args: ['educationSeriesId', 'healthSeriesId']
}
```

#### 2. SUBTRACT

Subtracts subsequent operands from the first.

```typescript
{
  op: 'subtract',
  args: ['revenueSeriesId', 'expenseSeriesId']
}
```

**Formula:** `result = args[0] - args[1] - args[2] - ...`

**Use Cases:**

- Budget deficit/surplus (revenue - expenses)
- Change over time (current - previous)
- Net values

**Behavior:**

- Missing data points default to 0
- Can result in negative values

**Example:**

```typescript
// Budget balance
{
  op: 'subtract',
  args: ['totalRevenueSeriesId', 'totalExpenseSeriesId']
}
```

#### 3. MULTIPLY

Multiplies all operands.

```typescript
{
  op: 'multiply',
  args: ['valueSeriesId', 'multiplierSeriesId']
}
```

**Use Cases:**

- Apply growth rates
- Scale values
- Index calculations

**Behavior:**

- Only includes points where ALL operands have values
- Missing data points exclude that time period from result

**Example:**

```typescript
// Adjust for inflation
{
  op: 'multiply',
  args: ['nominalBudgetSeriesId', 'inflationIndexSeriesId']
}
```

#### 4. DIVIDE

Divides first operand by subsequent operands.

```typescript
{
  op: 'divide',
  args: ['numeratorSeriesId', 'denominatorSeriesId']
}
```

**Formula:** `result = args[0] / args[1] / args[2] / ...`

**Use Cases:**

- Per capita calculations (when not using normalization)
- Ratios and proportions
- Growth rates (current / previous)

**Behavior:**

- Division by zero → point excluded from result (+ warning)
- Only includes points where ALL operands have values
- Missing data points exclude that time period

**Example:**

```typescript
// Education spending as % of total budget
{
  op: 'divide',
  args: [
    { op: 'multiply', args: ['educationSeriesId', 100] },
    'totalBudgetSeriesId'
  ]
}
```

### Nested Calculations

Calculations can be nested arbitrarily deep:

```typescript
{
  op: 'divide',
  args: [
    { op: 'subtract', args: ['revenue2024', 'revenue2023'] },
    'revenue2023'
  ]
}
```

This calculates: `(revenue2024 - revenue2023) / revenue2023` (year-over-year growth rate)

### Using Constants

You can include numeric constants in calculations:

```typescript
{
  op: 'multiply',
  args: ['valueSeriesId', 1000000]  // Convert to millions
}
```

```typescript
{
  op: 'divide',
  args: [
    { op: 'sum', args: ['entity1', 'entity2', 'entity3'] },
    3  // Average of 3 entities
  ]
}
```

### Cycle Detection

The system validates calculations to prevent circular dependencies:

```
Series A calculates from Series B
Series B calculates from Series C  ✓ Valid
Series C calculates from Series A  ✗ Circular dependency!
```

**Error Handling:**

- Validation occurs before saving
- Clear error message identifies the cycle
- Chart cannot be saved with circular dependencies

---

## Best Practices

### 1. Filter Design

**Start Broad, Then Narrow:**

```typescript
// Good: Start with category, then add specifics
{
  account_category: 'ch',
  entity_types: ['UAT'],
  functional_prefixes: ['70.'],
  min_population: 100000
}

// Less useful: Too specific from the start might return no data
{
  functional_codes: ['70.01.01.05.03'],
  entity_cuis: ['12345678']
}
```

**Use Prefixes for Aggregation:**

```typescript
// Aggregate entire category
functional_prefixes: ['70.']  // Better than listing all subcodes
```

**Combine Geographic and Classification Filters:**

```typescript
{
  county_codes: ['CJ'],           // Cluj county
  functional_prefixes: ['70.'],  // Education
  entity_types: ['UAT']          // Municipalities
}
```

### 2. Period Selection

**Time-Series: Use Intervals**

```typescript
{
  type: 'YEAR',
  selection: { interval: { start: '2016', end: '2025' } }
}
```

**Specific Comparisons: Use Dates**

```typescript
{
  type: 'YEAR',
  selection: { dates: ['2018', '2020', '2022', '2024'] }  // Election years
}
```

**Seasonal Analysis: Use Quarters**

```typescript
{
  type: 'QUARTER',
  selection: { interval: { start: '2023-Q1', end: '2023-Q4' } }
}
```

### 3. Series Organization

**Limit Active Series:**

- Time-series charts: 5-8 series maximum for readability
- Aggregated charts: 10-15 series maximum

**Use Visibility Toggle:**

```typescript
{
  enabled: true,      // Include in chart
  config: {
    visible: false    // But hide by default (user can enable)
  }
}
```

**Color Coding:**

- Use consistent colors for same entities across charts
- Use color gradients for related series
- Reserve red for negative values or warnings

### 4. Normalization Strategy

**Comparing Different-Sized Entities:**

```typescript
normalization: 'per_capita'  // Essential for fair comparison
```

**Absolute Budget Tracking:**

```typescript
normalization: 'total'  // See actual amounts
```

**EU Reporting:**

```typescript
normalization: 'total_euro'  // Match EU standards
```

### 5. Calculation Patterns

**Year-over-Year Growth:**

```typescript
{
  type: 'aggregated-series-calculation',
  calculation: {
    op: 'subtract',
    args: ['currentYearSeries', 'previousYearSeries']
  }
}
```

**Budget Balance:**

```typescript
{
  type: 'aggregated-series-calculation',
  calculation: {
    op: 'subtract',
    args: ['revenueSeriesId', 'expenseSeriesId']
  }
}
```

**Average of Entities:**

```typescript
{
  type: 'aggregated-series-calculation',
  calculation: {
    op: 'divide',
    args: [
      { op: 'sum', args: ['entity1', 'entity2', 'entity3'] },
      3
    ]
  }
}
```

### 6. Performance Considerations

**Avoid Over-Filtering:**

- Too many filters can result in no data
- Start broad, add filters incrementally

**Use Appropriate Report Type:**

- `PRINCIPAL_AGGREGATED` for overviews (faster)
- `DETAILED` only when necessary (slower)

**Limit Period Range:**

- Shorter intervals load faster
- Use year range in chart config to limit display

---

## Complete Examples

### Example 1: Simple Education Spending Trend

**Goal:** Show total education spending in Romania from 2016 to 2025.

```typescript
{
  id: "edu-trend-001",
  title: "Total Education Spending (2016-2025)",
  description: "Annual education budget execution across all entities",
  config: {
    chartType: "line",
    color: "#0062ff",
    showDataLabels: false,
    showGridLines: true,
    showLegend: true,
    showTooltip: true,
    showDiffControl: true,
    editAnnotations: false,
    showAnnotations: false
  },
  series: [
    {
      id: "edu-series-001",
      type: "line-items-aggregated-yearly",
      enabled: true,
      label: "Education Spending",
      unit: "",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2016", end: "2025" } }
        },
        account_category: "ch",
        functional_prefixes: ["70."],
        report_type: "Executie bugetara agregata la nivel de ordonator principal"
      },
      config: {
        visible: true,
        showDataLabels: false,
        color: "#0062ff"
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    }
  ],
  annotations: [],
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T10:00:00Z"
}
```

---

### Example 2: Multi-Entity Comparison (Per Capita)

**Goal:** Compare education spending per capita across Cluj, București, and Timișoara.

```typescript
{
  id: "edu-percapita-001",
  title: "Education Spending Per Capita - Major Cities",
  description: "Per capita comparison of education budgets",
  config: {
    chartType: "line",
    color: "#000000",
    showGridLines: true,
    showLegend: true,
    showTooltip: true,
    showDiffControl: false,
    editAnnotations: false,
    showAnnotations: false
  },
  series: [
    {
      id: "cluj-edu",
      type: "line-items-aggregated-yearly",
      enabled: true,
      label: "Cluj-Napoca",
      unit: "",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2018", end: "2025" } }
        },
        account_category: "ch",
        functional_prefixes: ["70."],
        uat_ids: ["cluj-napoca-uat-id"],  // Replace with actual UAT ID
        normalization: "per_capita",
        report_type: "Executie bugetara agregata la nivel de ordonator principal"
      },
      config: {
        visible: true,
        showDataLabels: false,
        color: "#0088FE"
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    },
    {
      id: "bucuresti-edu",
      type: "line-items-aggregated-yearly",
      enabled: true,
      label: "București",
      unit: "",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2018", end: "2025" } }
        },
        account_category: "ch",
        functional_prefixes: ["70."],
        uat_ids: ["bucuresti-uat-id"],
        normalization: "per_capita",
        report_type: "Executie bugetara agregata la nivel de ordonator principal"
      },
      config: {
        visible: true,
        showDataLabels: false,
        color: "#00C49F"
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    },
    {
      id: "timisoara-edu",
      type: "line-items-aggregated-yearly",
      enabled: true,
      label: "Timișoara",
      unit: "",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2018", end: "2025" } }
        },
        account_category: "ch",
        functional_prefixes: ["70."],
        uat_ids: ["timisoara-uat-id"],
        normalization: "per_capita",
        report_type: "Executie bugetara agregata la nivel de ordonator principal"
      },
      config: {
        visible: true,
        showDataLabels: false,
        color: "#FFBB28"
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    }
  ],
  annotations: [],
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T10:00:00Z"
}
```

---

### Example 3: Budget Deficit Calculation

**Goal:** Calculate and display budget deficit (revenue - expenses) for Romania.

```typescript
{
  id: "budget-deficit-001",
  title: "National Budget Deficit (2016-2025)",
  description: "Surplus/deficit calculated as total revenue minus total expenses",
  config: {
    chartType: "area",
    color: "#000000",
    showGridLines: true,
    showLegend: true,
    showTooltip: true,
    showDiffControl: false,
    editAnnotations: true,
    showAnnotations: true
  },
  series: [
    {
      id: "total-revenue",
      type: "line-items-aggregated-yearly",
      enabled: true,
      label: "Total Revenue",
      unit: "",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2016", end: "2025" } }
        },
        account_category: "vn",  // Revenue
        report_type: "Executie bugetara agregata la nivel de ordonator principal"
      },
      config: {
        visible: true,
        showDataLabels: false,
        color: "#00C49F"
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    },
    {
      id: "total-expenses",
      type: "line-items-aggregated-yearly",
      enabled: true,
      label: "Total Expenses",
      unit: "",
      filter: {
        report_period: {
          type: "YEAR",
          selection: { interval: { start: "2016", end: "2025" } }
        },
        account_category: "ch",  // Expenses
        report_type: "Executie bugetara agregata la nivel de ordonator principal"
      },
      config: {
        visible: true,
        showDataLabels: false,
        color: "#FF8042"
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    },
    {
      id: "budget-balance",
      type: "aggregated-series-calculation",
      enabled: true,
      label: "Budget Balance (Surplus/Deficit)",
      unit: "RON",
      calculation: {
        op: "subtract",
        args: ["total-revenue", "total-expenses"]
      },
      config: {
        visible: true,
        showDataLabels: true,
        color: "#8884d8"
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    }
  ],
  annotations: [
    {
      id: "crisis-2020",
      type: "annotation",
      enabled: true,
      locked: false,
      title: "COVID-19 Impact",
      subtitle: "Sharp increase in deficit due to pandemic response",
      color: "#FF0000",
      connector: true,
      subject: true,
      label: true,
      pX: 0.67,  // Position at ~2020 on x-axis
      pY: 0.3,
      pXDelta: 0.05,
      pYDelta: 0.1
    }
  ],
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T10:00:00Z"
}
```

---

## Summary

This guide provides a comprehensive reference for constructing charts using the Transparenta.eu schema system. Key takeaways:

### For AI Agents

1. **Always specify `account_category`** - Required field ('ch' or 'vn')
2. **Use `report_period` properly** - Define time dimension with type and selection
3. **Leverage prefixes** - Use `functional_prefixes` and `economic_prefixes` for broader queries
4. **Combine filters strategically** - Mix geographic, classification, and entity filters for precise queries
5. **Choose appropriate normalization** - Use `per_capita` for fair comparisons
6. **Use calculations wisely** - Validate dependencies, avoid cycles
7. **Start with examples** - Adapt the complete examples to your specific use case

### Common Patterns

- **Trend Analysis**: `report_period` interval + single filter dimension
- **Comparisons**: Multiple series with varying one dimension (entity, classification, etc.)
- **Breakdowns**: Aggregated charts (pie, treemap) with single period
- **Calculations**: Use `aggregated-series-calculation` for derived metrics
- **Context**: Combine budget data with `static-series` for economic indicators

### Validation

Before finalizing a chart schema:

- Ensure all series IDs are unique
- Verify calculation dependencies exist
- Check that period formats match the type
- Confirm filter combinations will return data
- Test with broader filters first, then narrow

---

**Document Version:** 2.0 - Comprehensive Guide
**Last Updated:** 2025-01-15
**System Version:** Transparenta.eu Chart Builder v2.0

For questions or clarifications, refer to the source code:

- Schema definitions: [src/schemas/charts.ts](../src/schemas/charts.ts)
- API implementation: [src/lib/api/charts.ts](../src/lib/api/charts.ts)
- Filter utilities: [src/lib/filterUtils.ts](../src/lib/filterUtils.ts)
- Chart components: [src/components/charts/](../src/components/charts/)
