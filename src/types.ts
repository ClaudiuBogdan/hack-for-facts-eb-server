// Represents the data extracted consistently, regardless of source XML structure
export interface NormalizedData {
  cui?: string;
  entityName?: string;
  sectorType?: string;
  address?: string;
  parent1?: string;
  parent2?: string;
  reportingDate?: string; // Extracted date string
  formatId: string; // Identifier for the detected format
  lineItems: LineItem[];
  // Store original file path for context
  filePath: string;
  year: string;
  month: string;
}

export interface LineItem {
  functionalCode?: string;
  functionalName?: string;
  economicCode?: string;
  accountCategory?: string;
  economicName?: string;
  fundingSource?: string;
  amount?: number; // Example: Extracting amount if present
}

export type AxisDataType = 'STRING' | 'INTEGER' | 'FLOAT' | 'DATE';

export interface Axis {
  name: string;
  type: AxisDataType;
  unit: string;
}

export interface AnalyticsDataPoint {
  x: string;
  y: number;
}

export interface AnalyticsSeries {
  seriesId: string;
  xAxis: Axis;
  yAxis: Axis;
  data: AnalyticsDataPoint[];
}

// ------------------------------
// Unified Analytics Filter Types
// ------------------------------

export type TMonth = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12'
export type TQuarter = 'Q1' | 'Q2' | 'Q3' | 'Q4'

export type YearPeriod = `${number}`
export type YearMonthPeriod = `${number}-${TMonth}`
export type YearQuarterPeriod = `${number}-${TQuarter}`
export type ReportPeriodType = 'YEAR' | 'MONTH' | 'QUARTER'
export type PeriodDate = YearPeriod | YearMonthPeriod | YearQuarterPeriod

export type PeriodSelection =
  | { interval: { start: PeriodDate; end: PeriodDate }; dates?: undefined }
  | { dates: PeriodDate[]; interval?: undefined }

export interface ReportPeriodInput {
  readonly type: ReportPeriodType
  readonly selection: PeriodSelection
}

export type GqlReportType = 'PRINCIPAL_AGGREGATED' | 'SECONDARY_AGGREGATED' | 'DETAILED'

// Narrow alias for places that accept only income/expense categories
export type AccountCategory = "vn" | "ch";

export type NormalizationMode = "total" | "per_capita" | "total_euro" | "per_capita_euro";

export type ExpenseType = "dezvoltare" | "functionare";

export interface AnalyticsFilter {
  // Required scope
  account_category: AccountCategory;
  report_type: string;
  report_period: ReportPeriodInput; // Preferred selector (month/quarter/year via month anchors)

  // Line-item dimensional filters (WHERE on ExecutionLineItems or joined dims)
  report_ids?: string[];
  entity_cuis?: string[];
  main_creditor_cui?: string;
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: number[];
  budget_sector_ids?: number[];
  expense_types?: ExpenseType[];
  program_codes?: string[];

  // Geography / entity scope (joins to Entities/UATs)
  county_codes?: string[];
  regions?: string[];
  uat_ids?: number[];
  entity_types?: string[];
  is_uat?: boolean;
  search?: string;

  // Population constraints (missing population is treated as 0)
  min_population?: number | null;
  max_population?: number | null;

  // Transform and aggregated thresholds (HAVING on aggregated measure)
  normalization?: NormalizationMode; // default 'total'
  aggregate_min_amount?: number | null;
  aggregate_max_amount?: number | null;

  // Per-item thresholds
  item_min_amount?: number | null;
  item_max_amount?: number | null;

  // Exclusions: apply negative matching for the same dimensions as above
  exclude?: AnalyticsExclude;
}

export interface AnalyticsExclude {
  report_ids?: string[];
  entity_cuis?: string[];
  main_creditor_cui?: string;
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: number[];
  budget_sector_ids?: number[];
  expense_types?: ExpenseType[];
  program_codes?: string[];
  county_codes?: string[];
  regions?: string[];
  uat_ids?: number[];
  entity_types?: string[];
}

// ------------------------------
// Shared SQL builder contracts
// ------------------------------

/**
 * Standardized parts produced by repository filter builders.
 * - joins: any JOIN clauses required (including leading space if non-empty)
 * - where: WHERE clause beginning with a single leading space (or empty string)
 * - having: optional HAVING clause beginning with a single leading space (or empty string)
 * - values: bound parameter values in order
 * - nextIndex: next positional parameter index the caller should use
 */
export interface SqlFilterParts {
  joins: string;
  where: string;
  having?: string;
  values: any[];
  nextIndex: number;
}

/**
 * Optional extra SELECT columns and ORDER BY used for search relevance and stable sorting.
 */
export interface QueryOrderParts {
  selectExtra: string;
  orderBy: string;
}

/**
 * Function type for building SQL filter parts for a given repository filter type.
 */
export type FilterBuilder<F> = (filter: F, initialIndex?: number) => SqlFilterParts;

/**
 * Function type for building HAVING clauses that depend on aggregate expressions and normalization.
 */
export type HavingBuilder = (opts: {
  normalization?: NormalizationMode;
  baseIndex: number;
  values: any[];
}) => { having: string; nextIndex: number };
