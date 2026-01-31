import { Decimal } from 'decimal.js';

import { Frequency } from '@/common/types/temporal.js';

import type {
  Axis,
  Currency,
  NormalizationMode,
  ReportPeriodInput,
} from '@/common/types/analytics.js';
import type { CommitmentsMetric, DbCommitmentsReportType } from '@/common/types/commitments.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentsExclude {
  report_ids?: string[];
  entity_cuis?: string[];
  main_creditor_cui?: string;

  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];

  funding_source_ids?: string[];
  budget_sector_ids?: string[];

  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[];
  entity_types?: string[];
}

/**
 * Internal filter type for Commitments queries.
 *
 * Notes:
 * - Numeric IDs are kept as string[] for GraphQL compatibility; repositories convert to numbers.
 * - Normalization fields are required internally (resolvers apply defaults).
 */
export interface CommitmentsFilter {
  // Required
  report_period: ReportPeriodInput;

  // Optional report type (some queries enforce it at runtime)
  report_type?: DbCommitmentsReportType;

  // Entity scope
  entity_cuis?: string[];
  main_creditor_cui?: string;
  entity_types?: string[];
  is_uat?: boolean;
  search?: string;

  // Classifications
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];

  // Budget dimensions
  funding_source_ids?: string[];
  budget_sector_ids?: string[];

  // Geography
  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[];

  // Population
  min_population?: number | null;
  max_population?: number | null;

  // Amount thresholds
  aggregate_min_amount?: number | null;
  aggregate_max_amount?: number | null;
  item_min_amount?: number | null;
  item_max_amount?: number | null;

  // Transforms
  normalization: NormalizationMode;
  currency: Currency;
  inflation_adjusted: boolean;
  show_period_growth: boolean;

  // Exclusions
  exclude?: CommitmentsExclude;
  exclude_transfers: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

export interface PageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentsMonthlySummary {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL union discriminator field.
  __typename: 'CommitmentsMonthlySummary';
  year: number;
  month: number;
  entity_cui: string;
  entity_name: string;
  main_creditor_cui: string | null;
  report_type: DbCommitmentsReportType;
  /** Optional population included for per-capita normalization (not exposed in GraphQL schema). */
  population?: number | null;

  credite_angajament: Decimal;
  plati_trezor: Decimal;
  plati_non_trezor: Decimal;
  receptii_totale: Decimal;
  receptii_neplatite_change: Decimal;

  total_plati: Decimal;
}

export interface CommitmentsQuarterlySummary {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL union discriminator field.
  __typename: 'CommitmentsQuarterlySummary';
  year: number;
  quarter: number;
  entity_cui: string;
  entity_name: string;
  main_creditor_cui: string | null;
  report_type: DbCommitmentsReportType;
  /** Optional population included for per-capita normalization (not exposed in GraphQL schema). */
  population?: number | null;

  credite_angajament: Decimal;
  limita_credit_angajament: Decimal;
  credite_bugetare: Decimal;
  credite_angajament_initiale: Decimal;
  credite_bugetare_initiale: Decimal;
  credite_angajament_definitive: Decimal;
  credite_bugetare_definitive: Decimal;
  credite_angajament_disponibile: Decimal;
  credite_bugetare_disponibile: Decimal;
  receptii_totale: Decimal;
  plati_trezor: Decimal;
  plati_non_trezor: Decimal;
  receptii_neplatite: Decimal;

  total_plati: Decimal;
  execution_rate: Decimal | null;
  commitment_rate: Decimal | null;
}

export interface CommitmentsAnnualSummary {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL union discriminator field.
  __typename: 'CommitmentsAnnualSummary';
  year: number;
  entity_cui: string;
  entity_name: string;
  main_creditor_cui: string | null;
  report_type: DbCommitmentsReportType;
  /** Optional population included for per-capita normalization (not exposed in GraphQL schema). */
  population?: number | null;

  credite_angajament: Decimal;
  limita_credit_angajament: Decimal;
  credite_bugetare: Decimal;
  credite_angajament_initiale: Decimal;
  credite_bugetare_initiale: Decimal;
  credite_angajament_definitive: Decimal;
  credite_bugetare_definitive: Decimal;
  credite_angajament_disponibile: Decimal;
  credite_bugetare_disponibile: Decimal;
  receptii_totale: Decimal;
  plati_trezor: Decimal;
  plati_non_trezor: Decimal;
  receptii_neplatite: Decimal;

  total_plati: Decimal;
  execution_rate: Decimal | null;
  commitment_rate: Decimal | null;
}

export type CommitmentsSummaryResult =
  | CommitmentsMonthlySummary
  | CommitmentsQuarterlySummary
  | CommitmentsAnnualSummary;

export interface CommitmentsSummaryConnection {
  nodes: CommitmentsSummaryResult[];
  pageInfo: PageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line items
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentsLineItem {
  line_item_id: string;
  year: number;
  month: number;
  report_type: DbCommitmentsReportType;

  entity_cui: string;
  entity_name: string;
  main_creditor_cui: string | null;
  /** Optional population included for per-capita normalization (not exposed in GraphQL schema). */
  population?: number | null;

  budget_sector_id: number;
  budget_sector_name: string;

  funding_source_id: number;
  funding_source_name: string;

  functional_code: string;
  functional_name: string;

  economic_code: string | null;
  economic_name: string | null;

  // YTD metrics
  credite_angajament: Decimal;
  limita_credit_angajament: Decimal;
  credite_bugetare: Decimal;
  credite_angajament_initiale: Decimal;
  credite_bugetare_initiale: Decimal;
  credite_angajament_definitive: Decimal;
  credite_bugetare_definitive: Decimal;
  credite_angajament_disponibile: Decimal;
  credite_bugetare_disponibile: Decimal;
  receptii_totale: Decimal;
  plati_trezor: Decimal;
  plati_non_trezor: Decimal;
  receptii_neplatite: Decimal;

  // Monthly deltas
  monthly_plati_trezor: Decimal;
  monthly_plati_non_trezor: Decimal;
  monthly_receptii_totale: Decimal;
  monthly_receptii_neplatite_change: Decimal;
  monthly_credite_angajament: Decimal;

  // Period flags
  is_quarterly: boolean;
  quarter: number | null;
  is_yearly: boolean;

  anomaly: 'YTD_ANOMALY' | 'MISSING_LINE_ITEM' | null;
}

export interface CommitmentsLineItemConnection {
  nodes: CommitmentsLineItem[];
  pageInfo: PageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentsAnalyticsInput {
  filter: CommitmentsFilter;
  metric: CommitmentsMetric;
  seriesId?: string;
}

export interface CommitmentsAnalyticsDataPoint {
  x: string;
  y: number;
  growth_percent?: number | null;
}

export interface CommitmentsAnalyticsSeries {
  seriesId: string;
  metric: CommitmentsMetric;
  xAxis: Axis;
  yAxis: Axis;
  data: CommitmentsAnalyticsDataPoint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentsAggregatedInput {
  filter: CommitmentsFilter;
  metric: CommitmentsMetric;
  limit: number;
  offset: number;
}

export interface CommitmentsAggregatedItem {
  functional_code: string;
  functional_name: string;
  economic_code: string | null;
  economic_name: string | null;
  amount: Decimal;
  count: number;
}

export interface CommitmentsAggregatedConnection {
  nodes: CommitmentsAggregatedItem[];
  pageInfo: PageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commitment vs Execution
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentExecutionComparisonInput {
  filter: CommitmentsFilter;
  commitments_metric: CommitmentsMetric;
}

export interface CommitmentExecutionDataPoint {
  period: string;
  commitment_value: Decimal;
  execution_value: Decimal;
  difference: Decimal;
  difference_percent: Decimal | null;
  commitment_growth_percent?: Decimal | null;
  execution_growth_percent?: Decimal | null;
  difference_growth_percent?: Decimal | null;
}

export interface CommitmentExecutionComparison {
  frequency: Frequency;
  data: CommitmentExecutionDataPoint[];
  total_commitment: Decimal;
  total_execution: Decimal;
  total_difference: Decimal;
  overall_difference_percent: Decimal | null;
  matched_count: number;
  unmatched_commitment_count: number;
  unmatched_execution_count: number;
}
