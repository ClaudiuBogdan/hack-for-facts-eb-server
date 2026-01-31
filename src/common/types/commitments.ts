import { Frequency } from './temporal.js';

import type { ReportPeriodInput } from './analytics.js';
import type { DbCommitmentsReportType, DbExecutionReportType } from './report-types.js';
export type { DbCommitmentsReportType, DbExecutionReportType } from './report-types.js';

// ============================================================================
// Report Type Mapping (Commitments)
// ============================================================================

export type GqlCommitmentsReportType = 'DETAILED' | 'PRINCIPAL_AGGREGATED' | 'SECONDARY_AGGREGATED';

export const COMMITMENTS_REPORT_TYPE_BY_GQL: Record<
  GqlCommitmentsReportType,
  DbCommitmentsReportType
> = {
  DETAILED: 'Executie - Angajamente bugetare detaliat',
  PRINCIPAL_AGGREGATED: 'Executie - Angajamente bugetare agregat principal',
  SECONDARY_AGGREGATED: 'Executie - Angajamente bugetare agregat secundar',
} as const;

export const COMMITMENTS_REPORT_TYPE_PRIORITY: readonly DbCommitmentsReportType[] = [
  'Executie - Angajamente bugetare agregat principal',
  'Executie - Angajamente bugetare agregat secundar',
  'Executie - Angajamente bugetare detaliat',
] as const;

// ============================================================================
// Report Type Mapping (Execution, for commitmentVsExecution)
// ============================================================================

export const EXECUTION_REPORT_TYPE_BY_COMMITMENTS: Record<
  DbCommitmentsReportType,
  DbExecutionReportType
> = {
  'Executie - Angajamente bugetare detaliat': 'Executie bugetara detaliata',
  'Executie - Angajamente bugetare agregat principal':
    'Executie bugetara agregata la nivel de ordonator principal',
  'Executie - Angajamente bugetare agregat secundar':
    'Executie bugetara agregata la nivel de ordonator secundar',
} as const;

// ============================================================================
// Metrics
// ============================================================================

export type CommitmentsMetric =
  | 'CREDITE_ANGAJAMENT'
  | 'PLATI_TREZOR'
  | 'PLATI_NON_TREZOR'
  | 'RECEPTII_TOTALE'
  | 'RECEPTII_NEPLATITE_CHANGE'
  | 'LIMITA_CREDIT_ANGAJAMENT'
  | 'CREDITE_BUGETARE'
  | 'CREDITE_ANGAJAMENT_INITIALE'
  | 'CREDITE_BUGETARE_INITIALE'
  | 'CREDITE_ANGAJAMENT_DEFINITIVE'
  | 'CREDITE_BUGETARE_DEFINITIVE'
  | 'CREDITE_ANGAJAMENT_DISPONIBILE'
  | 'CREDITE_BUGETARE_DISPONIBILE'
  | 'RECEPTII_NEPLATITE';

export function isMetricAvailableForPeriod(
  metric: CommitmentsMetric,
  frequency: Frequency
): boolean {
  const monthlyMetrics: ReadonlySet<CommitmentsMetric> = new Set([
    'CREDITE_ANGAJAMENT',
    'PLATI_TREZOR',
    'PLATI_NON_TREZOR',
    'RECEPTII_TOTALE',
    'RECEPTII_NEPLATITE_CHANGE',
  ]);

  if (frequency === Frequency.MONTH) {
    return monthlyMetrics.has(metric);
  }

  // For QUARTER/YEAR, all YTD metrics are available (13). The *_CHANGE metric is MONTH-only.
  return metric !== 'RECEPTII_NEPLATITE_CHANGE';
}

export type CommitmentsMetricColumn =
  | 'credite_angajament'
  | 'plati_trezor'
  | 'plati_non_trezor'
  | 'receptii_totale'
  | 'receptii_neplatite_change'
  | 'limita_credit_angajament'
  | 'credite_bugetare'
  | 'credite_angajament_initiale'
  | 'credite_bugetare_initiale'
  | 'credite_angajament_definitive'
  | 'credite_bugetare_definitive'
  | 'credite_angajament_disponibile'
  | 'credite_bugetare_disponibile'
  | 'receptii_neplatite';

export function metricToBaseColumn(metric: CommitmentsMetric): CommitmentsMetricColumn {
  switch (metric) {
    case 'CREDITE_ANGAJAMENT':
      return 'credite_angajament';
    case 'PLATI_TREZOR':
      return 'plati_trezor';
    case 'PLATI_NON_TREZOR':
      return 'plati_non_trezor';
    case 'RECEPTII_TOTALE':
      return 'receptii_totale';
    case 'RECEPTII_NEPLATITE_CHANGE':
      return 'receptii_neplatite_change';
    case 'LIMITA_CREDIT_ANGAJAMENT':
      return 'limita_credit_angajament';
    case 'CREDITE_BUGETARE':
      return 'credite_bugetare';
    case 'CREDITE_ANGAJAMENT_INITIALE':
      return 'credite_angajament_initiale';
    case 'CREDITE_BUGETARE_INITIALE':
      return 'credite_bugetare_initiale';
    case 'CREDITE_ANGAJAMENT_DEFINITIVE':
      return 'credite_angajament_definitive';
    case 'CREDITE_BUGETARE_DEFINITIVE':
      return 'credite_bugetare_definitive';
    case 'CREDITE_ANGAJAMENT_DISPONIBILE':
      return 'credite_angajament_disponibile';
    case 'CREDITE_BUGETARE_DISPONIBILE':
      return 'credite_bugetare_disponibile';
    case 'RECEPTII_NEPLATITE':
      return 'receptii_neplatite';
  }
}

/**
 * Returns the appropriate fact-table column for the requested metric and frequency.
 *
 * - MONTH uses monthly delta columns (5 metrics only)
 * - QUARTER uses quarterly delta columns (13 metrics, *_CHANGE is invalid)
 * - YEAR uses YTD columns (13 metrics, *_CHANGE is invalid)
 */
export function metricToFactColumn(metric: CommitmentsMetric, frequency: Frequency): string {
  const base = metricToBaseColumn(metric);

  if (frequency === Frequency.MONTH) {
    switch (metric) {
      case 'CREDITE_ANGAJAMENT':
        return 'monthly_credite_angajament';
      case 'PLATI_TREZOR':
        return 'monthly_plati_trezor';
      case 'PLATI_NON_TREZOR':
        return 'monthly_plati_non_trezor';
      case 'RECEPTII_TOTALE':
        return 'monthly_receptii_totale';
      case 'RECEPTII_NEPLATITE_CHANGE':
        return 'monthly_receptii_neplatite_change';
      default:
        // Caller should validate via isMetricAvailableForPeriod()
        return 'monthly_plati_trezor';
    }
  }

  if (frequency === Frequency.QUARTER) {
    if (metric === 'RECEPTII_NEPLATITE_CHANGE') {
      return 'quarterly_plati_trezor';
    }
    return `quarterly_${base}`;
  }

  // YEAR
  return base;
}

// ============================================================================
// Filters (Minimal shapes used by routing)
// ============================================================================

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

export interface CommitmentsFilter {
  report_period: ReportPeriodInput;
  report_type?: DbCommitmentsReportType;

  entity_cuis?: string[];
  main_creditor_cui?: string;
  entity_types?: string[];
  is_uat?: boolean;
  search?: string;

  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];

  funding_source_ids?: string[];
  budget_sector_ids?: string[];

  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[];

  min_population?: number | null;
  max_population?: number | null;

  aggregate_min_amount?: number | null;
  aggregate_max_amount?: number | null;
  item_min_amount?: number | null;
  item_max_amount?: number | null;

  // Normalization flags (used by calling layers; routing ignores these)
  normalization?: string;
  currency?: string;
  inflation_adjusted?: boolean;
  show_period_growth?: boolean;

  exclude?: CommitmentsExclude;
  exclude_transfers?: boolean;
}

/**
 * Determines whether `commitmentsSummary` / `commitmentsAnalytics` may use MV-backed queries.
 *
 * Mirrors the spec routing decision: any filter that requires classification-level
 * visibility or raw-row visibility forces a fact-table query.
 */
export function shouldUseMV(filter: CommitmentsFilter): boolean {
  // Budget dimensions are not included in MV grouping
  if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) return false;
  if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) return false;

  // Classification filters require fact table
  if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) return false;
  if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0)
    return false;
  if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) return false;
  if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) return false;

  // Exclusions by code/prefix require fact table
  if (filter.exclude?.functional_codes !== undefined && filter.exclude.functional_codes.length > 0)
    return false;
  if (
    filter.exclude?.functional_prefixes !== undefined &&
    filter.exclude.functional_prefixes.length > 0
  )
    return false;
  if (filter.exclude?.economic_codes !== undefined && filter.exclude.economic_codes.length > 0)
    return false;
  if (
    filter.exclude?.economic_prefixes !== undefined &&
    filter.exclude.economic_prefixes.length > 0
  )
    return false;

  // Transfer exclusion cannot be toggled off via MVs
  if (filter.exclude_transfers === false) return false;

  // Per-item thresholds require raw rows
  if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) return false;
  if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) return false;

  return true;
}
