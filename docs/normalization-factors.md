# Normalization Factors

This document explains the rationale and implementation of normalization factors for temporal data transformation.

## Overview

When transforming financial data (inflation adjustment, currency conversion, per-capita normalization), we need to apply time-varying factors to each data point. The accuracy of these transformations depends on matching the factor frequency to the data frequency.

## Core Principle: Frequency-Matched Factors

Each data point should be normalized using a factor from the same time period:

| Data Point           | Factor Used       |
| -------------------- | ----------------- |
| 2023-03 (March 2023) | March 2023 factor |
| 2023-Q2              | Q2 2023 factor    |
| 2023                 | 2023 factor       |

This ensures accurate normalization because factors (especially exchange rates) can vary significantly within a year.

## Factor Types

### 1. CPI (Consumer Price Index) - Inflation Adjustment

**Purpose**: Convert nominal values to real values (constant prices).

**Formula**: `real_value = nominal_value × (CPI_reference / CPI_period)`

**Reference Year**: Latest available year (CPI_latest = 100)

**Availability**:

- Year: Always available
- Month: Often available from statistical agencies
- Quarter: Can be derived from monthly or yearly

### 2. Exchange Rates - Currency Conversion

**Purpose**: Convert RON to EUR or USD.

**Formula**: `value_eur = value_ron / exchange_rate_ron_eur`

**Availability**:

- Year: Average rate for the year
- Month: Average rate for the month
- Quarter: Average rate for the quarter

**Note**: Exchange rates fluctuate significantly, so monthly factors provide much better accuracy than yearly for monthly data.

### 3. GDP - Percent of GDP Normalization

**Purpose**: Express values as percentage of GDP.

**Formula**: `percent_gdp = (value / gdp) × 100`

**Availability**:

- Year: Always available
- Quarter: Sometimes available
- Monthly: Not available (GDP is not a monthly concept)

**Note**: For month/quarter data, we use the annual GDP. This is standard practice.

### 4. Population - Per Capita Normalization

**Purpose**: Express values per person.

**Formula**: `per_capita = value / population`

**Availability**:

- Year: Always available
- Month/Quarter: Use yearly (population doesn't change significantly within a year)

## Fallback Strategy

When a factor is not available at the requested frequency, we use a cascading fallback with **carry-forward** semantics:

```
MONTH requested:
  1. Try monthly factor for that month
  2. Fallback: Use year factor for that year
  3. Fallback: Use previous period's value (carry forward)

QUARTER requested:
  1. Try quarterly factor for that quarter
  2. Fallback: Use year factor for that year
  3. Fallback: Use previous period's value (carry forward)

YEAR requested:
  1. Try year factor for that year
  2. Fallback: Use previous year's value (carry forward)
```

### Why Carry-Forward Instead of Default Value?

Financial factors like CPI and exchange rates don't suddenly reset to 1 - they evolve over time. Using the previous value is more accurate than using a default:

| Approach      | Example: Missing 2024-03 CPI | Result                              |
| ------------- | ---------------------------- | ----------------------------------- |
| Default (1.0) | Use 1.0                      | Incorrect - implies no inflation    |
| Carry-forward | Use 2024-02 value            | Correct - assumes similar inflation |

### Factor Map Generation

The system generates factor maps at the requested frequency using carry-forward:

```
Input:  Frequency = MONTH, Years = [2023, 2024]
        Year data: { 2023: 1.1 }
        Monthly data: { 2024-01: 1.02, 2024-02: 1.01 }

Output: Map with 24 entries

  2023-01 through 2023-12: 1.1   (from year)
  2024-01: 1.02                   (from monthly)
  2024-02: 1.01                   (from monthly)
  2024-03 through 2024-12: 1.01  (carry-forward from 2024-02)
```

**Important**: If no data exists at the start of the range (no yearly, no monthly, no previous value), those periods are **not included** in the map. This prevents incorrect normalization with arbitrary default values.

This approach:

- Generates the map once at query time
- Uses carry-forward for accurate gap filling
- Downstream code gets a map with only valid periods
- No arbitrary default values that could distort financial calculations

## Implementation

### Factor Map Structure

```typescript
// Factor maps are keyed by period label
type FactorMap = Map<string, Decimal>;

// Examples:
// YEARLY:    { "2023": 1.1, "2024": 1.0 }
// QUARTERLY: { "2023-Q1": 1.12, "2023-Q2": 1.11, ... }
// MONTHLY:   { "2023-01": 1.13, "2023-02": 1.12, ... }
```

### Factor Datasets Structure

```typescript
// Source data for generating factor maps
interface FactorDatasets {
  year: FactorMap; // Required - key format: "YYYY"
  quarter?: FactorMap; // Optional - key format: "YYYY-QN"
  month?: FactorMap; // Optional - key format: "YYYY-MM"
}
```

### Factor Map Generation

```typescript
// Generate a factor map at the requested frequency
// Uses carry-forward for missing periods
function generateFactorMap(
  frequency: Frequency,
  startYear: number,
  endYear: number,
  datasets: FactorDatasets
): FactorMap;
```

### Usage in Normalization Pipeline

```typescript
// 1. Determine frequency from data
const frequency = dataSeries.frequency;

// 2. Generate factor maps for that frequency (with carry-forward)
const factors = {
  cpi: generateFactorMap(frequency, startYear, endYear, cpiDatasets),
  eur: generateFactorMap(frequency, startYear, endYear, eurDatasets),
  // ...
};

// 3. Apply factors during transformation
for (const point of dataSeries.data) {
  const cpiFactor = factors.cpi.get(point.date);
  if (cpiFactor !== undefined) {
    // Apply transformation...
  }
}
```

## Edge Cases

### Missing Factor for a Period

The carry-forward strategy handles missing data gracefully:

1. **Gap in the middle**: Uses previous period's value
2. **Gap at the start**: Period is excluded from the map (prevents incorrect normalization)
3. **Gap at the end**: Uses last known value (carry-forward)

Example with gap at start:

```text
Input:  Frequency = MONTHLY, Years = [2023, 2024]
        Year data: { 2024: 1.0 }  // No 2023 data!

Output: Map with 12 entries (only 2024)
  2023-01 through 2023-12: NOT INCLUDED (no data, no previous)
  2024-01 through 2024-12: 1.0
```

### Ongoing Year (Incomplete Data)

For the current year where final values may not be available:

- The dataset should contain the latest available values
- Missing months carry forward from the last known value
- Dataset updates will automatically improve accuracy

Example:

```text
Current month: March 2024
Monthly CPI data: { 2024-01: 1.02, 2024-02: 1.01 }

Generated map for 2024:
  2024-01: 1.02
  2024-02: 1.01
  2024-03 through 2024-12: 1.01 (carry-forward)
```

### GDP for Sub-Annual Data

GDP is only meaningful at yearly frequency:

- For month/quarter data with `percent_gdp` normalization
- Always use the yearly GDP for the corresponding year
- Example: March 2023 data uses 2023 GDP

## Dataset Registry

The system requires specific datasets for normalization. These are validated at server startup.

### Required Datasets

| Dimension    | Dataset ID                             | Unit             | Description                                   |
| ------------ | -------------------------------------- | ---------------- | --------------------------------------------- |
| CPI          | `ro.economics.cpi.yearly`              | Index (2024=100) | Consumer Price Index for inflation adjustment |
| EUR Exchange | `ro.economics.exchange.ron_eur.yearly` | RON per EUR      | RON to EUR conversion                         |
| USD Exchange | `ro.economics.exchange.ron_usd.yearly` | RON per USD      | RON to USD conversion                         |
| GDP          | `ro.economics.gdp.yearly`              | Million RON      | Gross Domestic Product                        |

### Population Factor (Special Case)

Unlike CPI/Exchange/GDP which come from datasets and vary by year, **population comes from the database** via `PopulationRepository` and is **constant per query**.

Population is filter-dependent because:

- If querying specific entities/UATs/counties, divide by THEIR population
- If querying national data (no entity filters), divide by COUNTRY population
- The denominator does NOT change year-to-year within a single query

| Filter            | Population Source                                        |
| ----------------- | -------------------------------------------------------- |
| No entity filters | `getCountryPopulation()` - sum of all county populations |
| `entity_cuis`     | Resolved to UATs → sum of UAT populations                |
| `uat_ids`         | Sum of specified UAT populations                         |
| `county_codes`    | Sum of county-level populations                          |
| `entity_types`    | Based on type (e.g., county council → county population) |

### Startup Validation

The `NormalizationService` validates all required datasets exist at startup:

```typescript
// Server startup (api.ts)
const service = await NormalizationService.create(datasetRepo);
// Throws NormalizationDatasetError if any required datasets are missing
```

If datasets are missing, the server fails to start with a descriptive error:

```text
NormalizationDatasetError: Required normalization datasets are missing:
  - ro.economics.cpi.yearly: Dataset not found
  - ro.economics.gdp.yearly: Dataset not found
```

### Future Datasets (Optional)

When available, these will provide better accuracy for sub-annual data:

- `ro.economics.cpi.monthly`
- `ro.economics.cpi.quarterly`
- `ro.economics.exchange.ron_eur.monthly`
- `ro.economics.exchange.ron_usd.monthly`
