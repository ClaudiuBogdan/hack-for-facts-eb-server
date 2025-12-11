# Temporal Data Interface - Specification

## Purpose

Provide a standardized interface for modules to return time-series data from the database with consistent formatting and precision.

## Key Decisions

### 1. Date Representation

- **Decision**: Use period strings (YYYY, YYYY-MM, YYYY-Q[1-4])
- **Rationale**:
  - Unambiguous format across timezones
  - Natural ordering for sorting
  - Standard format for APIs and databases
  - Avoids separate year/month/quarter fields

### 2. Frequency Model

- **Decision**: Use enum with three values: MONTH, QUARTER, YEAR
- **Rationale**:
  - Matches budget execution data patterns in database
  - Clear contract - all points in a series have the same frequency
  - Simple to validate and process

### 3. Value Precision

- **Decision**: Use Decimal.js for all numeric values
- **Rationale**:
  - Financial data requires exact decimal arithmetic
  - Enforces "No Float Rule" project-wide
  - Prevents rounding errors in budget calculations

### 4. Data Structure

- **Decision**: Simple two-level structure (DataSeries contains DataPoint array)
- **Rationale**:
  - Minimal complexity for common use cases
  - No metadata at point level - keeps interface focused
  - Modules can extend with domain-specific wrappers if needed

### 5. DTO Format

- **Decision**: Convert Decimal to string for wire format
- **Rationale**:
  - JSON cannot represent Decimal natively
  - String preserves precision without floating point errors
  - TypeBox schemas validate string format

## Core Types

### Frequency Enum

```
MONTH   - One data point per month
QUARTER   - One data point per quarter
YEAR      - One data point per year
```

### DataPoint

- `date`: string (YYYY, YYYY-MM, YYYY-Q[1-4])
- `value`: Decimal number

### DataSeries

- `frequency`: Frequency enum value
- `data`: Array of DataPoint (ordered chronologically)

## Business Rules

### Date Formatting

- **Monthly**: 2024-03 for March 2024
- **Quarterly**: 2024-Q1 for Q1 2024
- **Yearly**: 2024 for year 2024

### Data Ordering

- Series data array must be ordered chronologically by date
- Modules are responsible for sorting before returning

### Frequency Consistency

- All points in a DataSeries must match the declared frequency
- No mixing of monthly and quarterly points in the same series

### Value Constraints

- Values must be valid decimal numbers
- Negative values are permitted (for corrections, adjustments)
- Zero is a valid value (not treated as null/undefined)

## Module Integration

### Shell Layer (Repositories)

- Query database using Kysely
- Map database rows to DataPoint with proper date formatting
- Construct DataSeries with appropriate frequency
- Return Result<DataSeries, Error>

### GraphQL Layer

- Convert DataSeries to DTO (Decimal → string)
- Define GraphQL types matching DTO structure
- Return serialized format in responses

### Core Layer

- Work with Decimal values directly
- Perform aggregations, calculations using Decimal.js
- Return Result<DataSeries, Error> from logic functions

## Validation

### Runtime (TypeBox)

- FrequencySchema: Validates enum values
- DataPointSchema: Validates date format and value string
- DataSeriesSchema: Validates complete structure

### Compile-time (TypeScript)

- Type safety for Frequency enum
- Decimal type for values (not number)
- Strict typing prevents accidental floats

## Extension Points

Modules needing additional metadata can:

1. Wrap DataSeries in domain-specific type
2. Use separate lookup structures keyed by date
3. Create module-specific types that include DataSeries as a field

## Non-Goals

- Point-level metadata (keep points simple)
- Complex aggregation logic (modules implement as needed)
- Time zone handling (dates are logical, not timestamps)
- Gap filling or interpolation (modules decide policy)
- Multiple value series in one structure (use separate DataSeries)
