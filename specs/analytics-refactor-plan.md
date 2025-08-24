# Data modeling for Analytics

```gql
type AnalyticsSeries {
  # A unique identifier for this data series.
  seriesId: String!

  # Metadata for the X-axis.
  xAxis: Axis!
  # Metadata for the Y-axis.
  yAxis: Axis!

  # The array of data points for this series.
  data: [AnalyticsDataPoint!]!
}
```

```gql
# Represents a single data point in a series.
type AnalyticsDataPoint {
  # The value for the X-axis. Its interpretation depends on the xAxis.type.
  # e.g., "2023", "Salaries", "2024-08-22"
  x: String!

  # The primary numeric value for the Y-axis.
  y: Float!
}
```

```gql
enum AxisDataType {
  STRING
  INTEGER
  FLOAT
  DATE # ISO-8601 strings
}

# Describes an axis of a chart, providing essential metadata for rendering.
type Axis {
  # The name of the axis, suitable for display as a label (e.g., "Year", "Amount").
  name: String!
  # The data type for the values on this axis.
  type: AxisDataType!
  # The unit of measurement for the axis values (e.g., "RON", "EUR", "per_capita").
  unit: String!
}
```

## Analytics Refactor Plan: adopt AnalyticsSeries / AnalyticsDataPoint / Axis

This plan refactors the analytics results to the new data model described in `specs/data-series-interface.md`.

### New GraphQL schema types to introduce
- Add types to `src/graphql/types/index.ts`:
  - `enum AxisDataType { STRING INTEGER FLOAT DATE }`
  - `type Axis { name: String!, type: AxisDataType!, unit: String! }`
  - `type AnalyticsDataPoint { x: String!, y: Float! }`
  - `type AnalyticsSeries { seriesId: String!, xAxis: Axis!, yAxis: Axis!, data: [AnalyticsDataPoint!]! }`

- Replace usages of old analytics result:
  - Remove `type YearlyAmount`, `type AnalyticsResult`, and any `yearlyTrend` fields where used for charts.
  - Update `Query.executionAnalytics` to return `[AnalyticsSeries!]!` instead of `[AnalyticsResult!]!`.
  - Update `Entity.incomeTrend/expenseTrend/balanceTrend` return type to `AnalyticsSeries!`.
  - Consider renaming `StaticAnalyticsDataPoint` or adapting static dataset query to return `[AnalyticsSeries!]!`.

### TypeScript types to update
- `src/types.ts`:
  - Remove `export interface AnalyticsResult { seriesId: string; unit: string; yearlyTrend: { year: number; value: number }[] }`.
  - Add runtime-facing types if needed by resolvers/services:
    - `export type AxisDataType = 'STRING' | 'INTEGER' | 'FLOAT' | 'DATE'`
    - `export interface Axis { name: string; type: AxisDataType; unit: string }`
    - `export interface AnalyticsDataPoint { x: string; y: number }`
    - `export interface AnalyticsSeries { seriesId: string; xAxis: Axis; yAxis: Axis; data: AnalyticsDataPoint[] }`

### Affected resolvers and changes
- `src/graphql/resolvers/analyticsResolver.ts`
  - Update `executionAnalytics` to build `AnalyticsSeries` objects:
    - Fetch the old yearly trend via repository and map to `{ x: String(year), y: value }`.
    - Provide `xAxis` metadata: `{ name: 'Year', type: 'INTEGER', unit: '' }` (or as needed per series).
    - Provide `yAxis` metadata: name can be derived from context or generic `'Amount'`; `type: 'FLOAT'`; `unit` from `getNormalizationUnit(filter.normalization)` or repository output.
    - Return `[AnalyticsSeries]`.
  - Update heatmap query return types unchanged (they don’t use this model).

- `src/graphql/resolvers/entityResolver.ts`
  - For `incomeTrend`, `expenseTrend`, `balanceTrend`:
    - Replace current return `{ seriesId, unit, yearlyTrend: [...] }` mapping with `AnalyticsSeries` shape.
    - `seriesId`: e.g., `incomeTrend:${entity.cui}` (or keep existing seriesId if present).
    - `xAxis`: `{ name: 'Year', type: 'INTEGER', unit: '' }`.
    - `yAxis`: `{ name: 'Amount', type: 'FLOAT', unit: unitFromNormalization }`.
    - `data`: `trends.map(t => ({ x: String(t.year), y: t.totalIncome|totalExpenses|budgetBalance }))`.

- `src/graphql/resolvers/datasetResolver.ts`
  - `staticChartAnalytics`: transform dataset definitions into `AnalyticsSeries` list:
    - `seriesId: d.id`
    - `xAxis: { name: 'Year', type: 'INTEGER', unit: '' }`
    - `yAxis: { name: d.name or 'Amount', type: 'FLOAT', unit: d.unit }`
    - `data: d.yearlyTrend.map(p => ({ x: String(p.year), y: p.value }))`
  - Consider removing `StaticAnalyticsDataPoint` type or rewriting schema accordingly.

### Affected repositories and changes
Repositories generally produce raw aggregates. We minimize changes here and adapt mapping in resolvers.

- `src/db/repositories/executionLineItemRepository.ts`
  - Keep `getYearlyTrend(filter)` return shape `{ year: number; value: number }[]`.
  - Do NOT rename method; mapping to `AnalyticsDataPoint` is done in resolvers.

- `src/db/repositories/entityAnalyticsRepository.ts`, `countyAnalyticsRepository.ts`, `uatAnalyticsRepository.ts`, `aggregatedLineItemsRepository.ts`
  - No shape changes required for heatmaps or entity analytics tables.

### GraphQL schema updates (edits in `src/graphql/types/index.ts`)
- Remove types:
  - `type YearlyAmount` (if not used elsewhere)
  - `type AnalyticsResult`
  - `type StaticAnalyticsDataPoint`
- Change fields:
  - `input AnalyticsInput` remains the same.
  - `Query.executionAnalytics`: change return type to `[AnalyticsSeries!]!`.
  - `Entity.incomeTrend/expenseTrend/balanceTrend`: change return type to `AnalyticsSeries!`.
  - `Query.staticChartAnalytics`: change to return `[AnalyticsSeries!]!`.
- Add new types/enums for Axis/AnalyticsSeries/AnalyticsDataPoint.

### Concrete edit checklist
1) Schema (`src/graphql/types/index.ts`)
   - Add `AxisDataType`, `Axis`, `AnalyticsDataPoint`, `AnalyticsSeries` type definitions.
   - Replace usages: `AnalyticsResult` -> `AnalyticsSeries`; `YearlyAmount` removed; `StaticAnalyticsDataPoint` removed; `executionAnalytics` & `staticChartAnalytics` outputs updated; update `Entity` trend fields.

2) Types (`src/types.ts`)
   - Add TS interfaces for Axis/AnalyticsSeries.
   - Remove `AnalyticsResult` interface and any imports.

3) Resolvers
   - `analyticsResolver.ts`: update `executionAnalytics` logic:
     - Determine requested fields for `xAxis`, `yAxis`, `data` as before (if selective fetching is used).
     - Compose the object:
       ```ts
       const unit = getNormalizationUnit(input.filter.normalization);
       const yearly = await executionLineItemRepository.getYearlyTrend(input.filter);
       const series: AnalyticsSeries = {
         seriesId: input.seriesId ?? 'series',
         xAxis: { name: 'Year', type: 'INTEGER', unit: '' },
         yAxis: { name: 'Amount', type: 'FLOAT', unit },
         data: yearly.map(p => ({ x: String(p.year), y: p.value }))
       };
       ```

   - `entityResolver.ts`: update `incomeTrend`, `expenseTrend`, `balanceTrend` to return `AnalyticsSeries` as above; compute y values (income/expense/balance) and set `unit` using normalization.

   - `datasetResolver.ts`: map datasets to `AnalyticsSeries` list.

4) Clean up
   - Remove imports and types of `AnalyticsResult` in resolvers and anywhere else.
   - Ensure tests/build pass.

### GraphQL query contract changes to communicate
- `executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsSeries!]!`
- `staticChartAnalytics(seriesIds: [ID!]!): [AnalyticsSeries!]!`
- `Entity.{incomeTrend,expenseTrend,balanceTrend}: AnalyticsSeries!`

### Risks and validation
- Ensure no remaining references to `yearlyTrend`, `YearlyAmount`, `AnalyticsResult`, or `StaticAnalyticsDataPoint` in GraphQL types and resolvers.
- Confirm `Normalization` unit handling continues to behave (RON/EUR/per_capita).
- Run `yarn tsc -b --noEmit` and fix any type errors.
- Regenerate OpenAPI, if applicable, and update specs/docs.

### Follow-ups (optional)
- If UI expects `yearlyTrend`, coordinate with frontend to adopt `AnalyticsSeries`.
- Consider richer `xAxis` labeling for non-year X dimensions in the future.
