/**
 * Advanced Map Analytics Module - Core Types
 *
 * Domain types for grouped map-series payloads.
 */

import type {
  AccountCategory,
  AnalyticsFilter,
  Currency,
  NormalizationMode,
  ReportPeriodInput,
} from '@/common/types/analytics.js';
import type {
  CommitmentsFilter as CommonCommitmentsFilter,
  CommitmentsMetric,
} from '@/common/types/commitments.js';

// ─────────────────────────────────────────────────────────────────────────────
// Request Types
// ─────────────────────────────────────────────────────────────────────────────

export type MapGranularity = 'UAT';
export const GROUPED_SERIES_RESERVED_ID_PREFIXES = ['group_'] as const;
export const GROUPED_SERIES_UNSAFE_CSV_ID_PREFIXES = ['=', '+', '-', '@'] as const;

interface MapRequestSeriesBase {
  id: string;
  unit?: string;
}

export type MapSeriesNormalizationMode = NormalizationMode | 'total_euro' | 'per_capita_euro';

export type ExecutionMapSeriesFilter = Omit<
  AnalyticsFilter,
  'account_category' | 'report_period'
> & {
  account_category: AccountCategory;
  report_period: ReportPeriodInput;
  normalization?: MapSeriesNormalizationMode;
  currency?: Currency;
  inflation_adjusted?: boolean;
  show_period_growth?: boolean;
} & Record<string, unknown>;

export interface ExecutionMapSeries extends MapRequestSeriesBase {
  type: 'line-items-aggregated-yearly';
  filter: ExecutionMapSeriesFilter;
}

export type CommitmentsMapSeriesFilter = Omit<
  CommonCommitmentsFilter,
  | 'report_period'
  | 'report_type'
  | 'normalization'
  | 'currency'
  | 'inflation_adjusted'
  | 'show_period_growth'
> & {
  report_period: ReportPeriodInput;
  report_type?: string;
  normalization?: MapSeriesNormalizationMode;
  currency?: Currency;
  inflation_adjusted?: boolean;
  show_period_growth?: boolean;
} & Record<string, unknown>;

export interface CommitmentsMapSeries extends MapRequestSeriesBase {
  type: 'commitments-analytics';
  metric: CommitmentsMetric;
  filter: CommitmentsMapSeriesFilter;
}

export interface InsMapSeries extends MapRequestSeriesBase {
  type: 'ins-series';
  datasetCode?: string;
  period?: ReportPeriodInput;
  aggregation?: 'sum' | 'average' | 'first';
  territoryCodes?: string[];
  sirutaCodes?: string[];
  unitCodes?: string[];
  classificationSelections?: Record<string, string[]>;
  hasValue?: boolean;
}

export interface UploadedMapDatasetSeries extends MapRequestSeriesBase {
  type: 'uploaded-map-dataset';
  datasetId?: string;
  datasetPublicId?: string;
}

export type MapRequestSeries =
  | ExecutionMapSeries
  | CommitmentsMapSeries
  | InsMapSeries
  | UploadedMapDatasetSeries;

export interface GroupedSeriesDataRequest {
  granularity: MapGranularity;
  series: MapRequestSeries[];
  requestUserId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warning Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupedSeriesWarning {
  type: string;
  message: string;
  seriesId?: string;
  sirutaCode?: string;
  details?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MapSeriesVector {
  seriesId: string;
  unit?: string;
  valuesBySirutaCode: Map<string, number | undefined>;
}

export interface GroupedSeriesProviderOutput {
  sirutaUniverse: string[];
  vectors: MapSeriesVector[];
  warnings: GroupedSeriesWarning[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Use-case Output Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupedSeriesManifestEntry {
  series_id: string;
  unit?: string;
  defined_value_count: number;
}

export interface GroupedSeriesManifest {
  generated_at: string;
  format: 'wide_matrix_v1';
  granularity: MapGranularity;
  series: GroupedSeriesManifestEntry[];
}

export interface GroupedSeriesMatrixRow {
  sirutaCode: string;
  valuesBySeriesId: Map<string, number | undefined>;
}

export interface GroupedSeriesMatrixData {
  manifest: GroupedSeriesManifest;
  seriesOrder: string[];
  rows: GroupedSeriesMatrixRow[];
  warnings: GroupedSeriesWarning[];
}
