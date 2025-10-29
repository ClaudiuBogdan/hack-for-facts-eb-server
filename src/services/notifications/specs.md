# Email Notification Content: What to Send and How to Fetch

We’ll keep payloads small but meaningful: a short summary, 2–4 key metrics, and a couple of perspective/comparison points. Below, for each notification type, we define the data to include and how to retrieve it using existing repositories or small additions.

## Newsletter: Entity Monthly

- Data to send
  - Period: label (e.g., "Oct 2025") and `periodKey`
  - Key metrics (period totals): totalExpenses, totalIncome, balance, executionRate
  - Change vs previous month: absolute and % for expenses and income
  - Year-over-year vs same month last year: absolute and %
  - Top 3 functional categories by spend; top 3 economic categories by spend
  - Entity link with period param
- How to fetch
  - Build `ReportPeriodInput` MONTH from `periodKey`
  - Totals: `executionLineItemRepository.getPeriodSnapshotTotals(entity.cui, reportPeriod, entity.default_report_type)`
  - MoM: compute previous monthly `periodKey`, refetch totals
  - YoY: compute same month last year `periodKey`, refetch totals
  - Trends for context (optional, 6–12 months): `executionLineItemRepository.getMonthlyTrend(filter)`
  - Top categories:
    - If available: aggregate repo calls for functional/economic
    - If missing: add light helpers: `getTopFunctionalTotalsForPeriod(entityCui, reportPeriod, limit)` and `getTopEconomicTotalsForPeriod(...)`

## Newsletter: Entity Quarterly

- Data to send
  - Period: label (e.g., "Q3 2025") and `periodKey`
  - Key metrics (quarter totals): totalExpenses, totalIncome, balance, executionRate
  - Quarter-over-quarter change and year-over-year (same quarter last year)
  - Top 3 functional and top 3 economic categories
  - Entity link with period param
- How to fetch
  - Build `ReportPeriodInput` QUARTER
  - Totals: `getPeriodSnapshotTotals`
  - QoQ: previous quarter `periodKey` + totals
  - YoY: same quarter last year `periodKey` + totals
  - Trends: `executionLineItemRepository.getQuarterlyTrend(filter)`
  - Top categories: same helpers as monthly with QUARTER period

## Newsletter: Entity Yearly

- Data to send
  - Period: "2025" and `periodKey`
  - Key metrics (year totals): totalExpenses, totalIncome, balance, executionRate
  - YoY change vs previous year
  - 3–5 year trend overview
  - Top 3 functional and top 3 economic categories for the year
  - Entity link with period param
- How to fetch
  - Build `ReportPeriodInput` YEAR
  - Totals: `getPeriodSnapshotTotals` or `getYearlySnapshotTotals`
  - YoY: prior year totals
  - Trends: `executionLineItemRepository.getYearlyTrend(filter)` (3–5 data points)
  - Top categories: helpers as above with YEAR period

## Alert: Analytics Series (alert_series_analytics)

- Data to send
  - Title/description from config
  - Last value (with unit), previous value delta (abs, %), and (if applicable) YoY delta
  - Mini trend stats: min, max, average over the last N points (e.g., 12 months or all returned)
  - Condition evaluations: which threshold(s) triggered; include operator, threshold, value
  - Optional: sparkline data (recent 12 points) for template
- How to fetch
  - We already fetch the series via provider (monthly/quarterly/yearly based on `filter.report_period.type`)
  - Compute:
    - `current = last(series.data)`; `prev = penultimate(series.data)`
    - deltaAbs = current.y - prev.y; deltaPct = prev.y ? deltaAbs/prev.y : null
    - YoY (if period is MONTH/QUARTER/YEAR and enough history): find point matching same month/quarter last year
    - stats: min/max/avg over last 12 points (or full set if shorter)
  - Evaluate `config.conditions` against `current.y` and attach results

## Alert: Static Series (alert_series_static)

- Data to send
  - Title/description; dataset metadata (source name/url)
  - Last value with unit; previous value delta (abs, %); YoY delta if axis is temporal
  - Mini trend stats: min, max, average over last N points
  - Optional: sparkline data
- How to fetch
  - Provider loads dataset by `datasetId` and returns `{ xAxis, yAxis, data }`
  - Inference:
    - Period type from `xAxis.unit`/`xAxis.type` (YEAR/QUARTER/MONTH/CATEGORY)
    - Compute last/prev, deltas, YoY (if temporal and point exists), stats as above

## Cross-cutting presentation

- Use `getNormalizationUnit` and yAxis.unit for currency/per-capita units
- Use `formatCurrency` in compact form and standard form when relevant (e.g., like `ai-basic.ts` getEntityDetails)
- Add links back to the client:
  - Entities: `buildEntityDetailsLink` or existing entity route link with `period`
  - Alerts: generate a shareable chart link (as in `generateAnalytics`) or a deep link with filter encoded
- Edge cases: if previous/YoY points missing, omit the comparison gracefully

## Output payload shapes (for template authoring)

```ts
// Newsletter payload (entity)
interface EntityNewsletterPayload {
  periodKey: string; // e.g., 2025-10, 2025-Q3, 2025
  periodLabel: string;
  granularity: 'MONTH' | 'QUARTER' | 'YEAR';
  entity: { cui: string; name: string; url: string };
  summary: { totalExpenses: number; totalIncome: number; balance: number; executionRate?: number };
  comparisons: {
    vsPrevious?: { expensesAbs: number; expensesPct?: number; incomeAbs: number; incomePct?: number };
    vsYoY?: { expensesAbs: number; expensesPct?: number; incomeAbs: number; incomePct?: number };
  };
  topFunctional?: Array<{ code: string; name?: string; amount: number }>;
  topEconomic?: Array<{ code: string; name?: string; amount: number }>;
  trend?: Array<{ x: string; y: number }>; // last 6–12 points
}

// Alert payload (series)
interface SeriesAlertPayload {
  title?: string; description?: string;
  series: { xAxis: { name: string; unit: string }; yAxis: { name: string; unit: string }; data: Array<{ x: string; y: number }> };
  current: { x: string; y: number };
  comparisons: { prev?: { abs: number; pct?: number }; yoy?: { abs: number; pct?: number } };
  stats: { min: number; max: number; avg: number; count: number };
  conditions?: Array<{ operator: 'gt'|'gte'|'lt'|'lte'|'eq'; threshold: number; unit: string; met: boolean }>;
  dataset?: { id?: string; sourceName?: string; sourceUrl?: string }; // for static alerts
}
```

## Implementation plan

1. Entity newsletters

   - Build a small helper that computes MoM/YoY using `getPeriodSnapshotTotals` for the current, previous, and YoY period; format `periodLabel`.
   - Add repository helpers for top functional/economic by period if missing.
   - Include a short trend (6–12 points) via `getMonthlyTrend`/`getQuarterlyTrend`/`getYearlyTrend`.

2. Analytics alerts

   - In providers, add utilities to compute prev/yoy deltas and min/max/avg; attach condition evaluation results.

3. Static alerts

   - Determine temporal axis; compute prev/yoy if possible; attach dataset metadata.

4. Formatting & links

   - Reuse `formatCurrency` and `buildEntityDetailsLink`; generate chart/share links where helpful.