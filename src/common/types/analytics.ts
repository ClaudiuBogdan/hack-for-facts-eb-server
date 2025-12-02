/* eslint-disable @typescript-eslint/naming-convention -- Matching database and GraphQL schema naming */

// -----------------------------------------
// Domain Types for Filtering
// -----------------------------------------

export type PeriodType = 'MONTH' | 'QUARTER' | 'YEAR';

export interface PeriodInterval {
  start: string; // YYYY, YYYY-MM, or YYYY-QX
  end: string;
}

export interface PeriodSelection {
  interval?: PeriodInterval;
  dates?: string[];
}

export interface ReportPeriod {
  type: PeriodType;
  selection: PeriodSelection;
}

export interface AnalyticsExclude {
  report_ids?: string[];
  entity_cuis?: string[];
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: string[];
  budget_sector_ids?: string[];
  expense_types?: ('dezvoltare' | 'functionare')[];
  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[];
  entity_types?: string[];
}

export interface AnalyticsFilter {
  // Required
  account_category: 'vn' | 'ch';
  report_period: ReportPeriod;

  // Dimensions
  report_type?: string;
  main_creditor_cui?: string;
  report_ids?: string[];
  entity_cuis?: string[];
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: string[];
  budget_sector_ids?: string[];
  expense_types?: ('dezvoltare' | 'functionare')[];
  program_codes?: string[];

  // Geography
  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[];
  entity_types?: string[];
  is_uat?: boolean;
  search?: string;

  // Population & Aggregation constraints
  min_population?: number;
  max_population?: number;
  aggregate_min_amount?: number;
  aggregate_max_amount?: number;
  item_min_amount?: number;
  item_max_amount?: number;

  // Exclusions
  exclude?: AnalyticsExclude;
}

// -----------------------------------------
// Domain Types for Normalization
// -----------------------------------------

export type Currency = 'RON' | 'EUR' | 'USD';

export type NormalizationMode = 'total' | 'per_capita' | 'percent_gdp';

export interface NormalizationOptions {
  normalization: NormalizationMode;
  currency?: Currency;
  inflation_adjusted: boolean;
  show_period_growth: boolean;
}

// -----------------------------------------
// Analytics Output Types
// -----------------------------------------

export type AxisDataType = 'STRING' | 'INTEGER' | 'FLOAT' | 'DATE';

export interface Axis {
  name: string;
  type: AxisDataType;
  unit: string;
}

export interface AnalyticsDataPoint {
  x: string;
  y: number; // We use number for GraphQL output, but logic uses Decimal
}

export interface AnalyticsSeries {
  seriesId: string;
  xAxis: Axis;
  yAxis: Axis;
  data: AnalyticsDataPoint[];
}
