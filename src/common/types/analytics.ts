import type { ExecutionGqlReportType } from './report-types.js';
import type { Frequency } from './temporal.js';

// -----------------------------------------
// Primitive Types & Aliases
// -----------------------------------------

/** Account category: income (vn) or expense (ch) */
export type AccountCategory = 'vn' | 'ch';

/** Expense type classification */
export type ExpenseType = 'dezvoltare' | 'functionare';

/** Supported currencies for financial data */
export type Currency = 'RON' | 'EUR' | 'USD';

/** GraphQL report type enum values (execution only) */
export type GqlReportType = ExecutionGqlReportType;

/** GraphQL period type enum values (MONTH, QUARTER, YEAR) */
export type PeriodType = 'MONTH' | 'QUARTER' | 'YEAR';

// -----------------------------------------
// Period Types (Temporal Filtering)
// -----------------------------------------

/** Month as two-digit string */
export type TMonth =
  | '01'
  | '02'
  | '03'
  | '04'
  | '05'
  | '06'
  | '07'
  | '08'
  | '09'
  | '10'
  | '11'
  | '12';

/** Quarter as Q1-Q4 */
export type TQuarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';

/** Year-only period (e.g., "2023") */
export type YearPeriod = `${number}`;

/** Year-month period (e.g., "2023-01") */
export type YearMonthPeriod = `${number}-${TMonth}`;

/** Year-quarter period (e.g., "2023-Q1") */
export type YearQuarterPeriod = `${number}-${TQuarter}`;

/** Any valid period date format */
export type PeriodDate = YearPeriod | YearMonthPeriod | YearQuarterPeriod;

/** Period selection: either an interval or explicit dates */
export type PeriodSelection =
  | { interval: { start: PeriodDate; end: PeriodDate }; dates?: undefined }
  | { dates: PeriodDate[]; interval?: undefined };

// -----------------------------------------
// GraphQL Input Types (uses PeriodType with 'type' field)
// -----------------------------------------

/** GraphQL report period input (uses PeriodType with MONTH/QUARTER/YEAR) */
export interface GqlReportPeriodInput {
  readonly type: PeriodType;
  readonly selection: PeriodSelection;
}

// -----------------------------------------
// Internal Domain Types (uses Frequency with 'frequency' field)
// -----------------------------------------

/** Report period input combining frequency and selection (internal domain type) */
export interface ReportPeriodInput {
  readonly type: Frequency;
  readonly selection: PeriodSelection;
}

// Legacy alias for backward compatibility
export type ReportPeriod = ReportPeriodInput;

// -----------------------------------------
// Analytics Filter Types
// -----------------------------------------

export interface AnalyticsExclude {
  report_ids?: string[];
  entity_cuis?: string[];
  main_creditor_cui?: string;
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: string[]; // String for GraphQL input, converted to number in repo
  budget_sector_ids?: string[]; // String for GraphQL input, converted to number in repo
  expense_types?: ExpenseType[];
  program_codes?: string[];
  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[]; // String for GraphQL input, converted to number in repo
  entity_types?: string[];
}

export interface AnalyticsFilter {
  // Required scope
  account_category: AccountCategory;
  report_type?: string;
  report_period: ReportPeriodInput;

  // Line-item dimensional filters
  report_ids?: string[];
  entity_cuis?: string[];
  main_creditor_cui?: string;
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: string[]; // String for GraphQL input, converted to number in repo
  budget_sector_ids?: string[]; // String for GraphQL input, converted to number in repo
  expense_types?: ExpenseType[];
  program_codes?: string[];

  // Geography / entity scope
  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[]; // String for GraphQL input, converted to number in repo
  entity_types?: string[];
  is_uat?: boolean;
  search?: string;

  // Population constraints
  min_population?: number | null;
  max_population?: number | null;

  // Aggregation thresholds
  aggregate_min_amount?: number | null;
  aggregate_max_amount?: number | null;

  // Per-item thresholds
  item_min_amount?: number | null;
  item_max_amount?: number | null;

  // Exclusions
  exclude?: AnalyticsExclude;
}

// -----------------------------------------
// Normalization Options
// -----------------------------------------

/** Normalization mode for data transformation */
export type NormalizationMode = 'total' | 'per_capita' | 'percent_gdp';

/** Extended normalization options including legacy values */
export interface NormalizationOptions {
  normalization: NormalizationMode;
  currency?: Currency;
  inflation_adjusted: boolean;
  show_period_growth: boolean;
}

// -----------------------------------------
// Analytics Output Types
// -----------------------------------------

/** Axis data type for charting */
export type AxisDataType = 'STRING' | 'INTEGER' | 'FLOAT' | 'DATE';

/** Axis definition for charts */
export interface Axis {
  name: string;
  type: AxisDataType;
  unit: string;
}

/** Single data point in analytics output */
export interface AnalyticsDataPoint {
  x: string;
  y: number; // Number for GraphQL output; internal logic uses Decimal
}

/** Complete analytics series for charting */
export interface AnalyticsSeries {
  seriesId: string;
  xAxis: Axis;
  yAxis: Axis;
  data: AnalyticsDataPoint[];
}
