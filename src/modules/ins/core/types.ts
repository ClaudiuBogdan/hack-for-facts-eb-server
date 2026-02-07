/**
 * Domain types for INS module.
 *
 * INS (Institutul National de Statistica) data is modeled as multi-dimensional
 * matrices (datasets) with temporal, territorial, classification, and unit dimensions.
 */

import type { Decimal } from 'decimal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for dataset listing */
export const DEFAULT_DATASET_LIMIT = 20;

/** Maximum allowed page size for dataset listing */
export const MAX_DATASET_LIMIT = 200;

/** Default page size for observation listing */
export const DEFAULT_OBSERVATION_LIMIT = 50;

/** Maximum allowed page size for observation listing */
export const MAX_OBSERVATION_LIMIT = 1000;

/** Default page size for dimension values */
export const DEFAULT_DIMENSION_VALUES_LIMIT = 50;

/** Maximum allowed page size for dimension values */
export const MAX_DIMENSION_VALUES_LIMIT = 1000;

/** Max rows returned for UAT indicator queries (non-paginated) */
export const MAX_UAT_INDICATORS_LIMIT = 2000;

/** Max rows returned for compare queries (non-paginated) */
export const MAX_COMPARE_LIMIT = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export type InsPeriodicity = 'ANNUAL' | 'QUARTERLY' | 'MONTHLY';
export type InsTerritoryLevel = 'NATIONAL' | 'NUTS1' | 'NUTS2' | 'NUTS3' | 'LAU';
export type InsSyncStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'STALE';
export type InsDimensionType = 'TEMPORAL' | 'TERRITORIAL' | 'CLASSIFICATION' | 'UNIT_OF_MEASURE';

// ─────────────────────────────────────────────────────────────────────────────
// Dataset Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InsDataset {
  id: number;
  code: string;
  name_ro: string | null;
  name_en: string | null;
  definition_ro: string | null;
  definition_en: string | null;
  periodicity: InsPeriodicity[];
  year_range: [number, number] | null;
  dimension_count: number;
  has_uat_data: boolean;
  has_county_data: boolean;
  has_siruta: boolean;
  sync_status: InsSyncStatus | null;
  last_sync_at: Date | null;
  context_code: string | null;
  context_name_ro: string | null;
  context_name_en: string | null;
  context_path: string | null;
  metadata: Record<string, unknown> | null;
}

export interface InsDatasetFilter {
  search?: string;
  codes?: string[];
  context_code?: string;
  root_context_code?: string;
  periodicity?: InsPeriodicity[];
  sync_status?: InsSyncStatus[];
  has_uat_data?: boolean;
  has_county_data?: boolean;
}

export interface InsDatasetPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface InsDatasetConnection {
  nodes: InsDataset[];
  pageInfo: InsDatasetPageInfo;
}

export interface InsContext {
  id: number;
  code: string;
  name_ro: string | null;
  name_en: string | null;
  name_ro_markdown: string | null;
  name_en_markdown: string | null;
  level: number | null;
  path: string;
  parent_id: number | null;
  parent_code: string | null;
  parent_name_ro: string | null;
  matrix_count: number;
}

export interface InsContextFilter {
  search?: string;
  level?: number;
  parent_code?: string;
  root_context_code?: string;
}

export interface InsContextPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface InsContextConnection {
  nodes: InsContext[];
  pageInfo: InsContextPageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimension Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InsDimension {
  matrix_id: number;
  index: number;
  type: InsDimensionType;
  label_ro: string | null;
  label_en: string | null;
  classification_type: InsClassificationType | null;
  is_hierarchical: boolean;
  option_count: number;
}

export interface InsDimensionValue {
  matrix_id: number;
  dim_index: number;
  nom_item_id: number;
  dimension_type: InsDimensionType;
  label_ro: string | null;
  label_en: string | null;
  parent_nom_item_id: number | null;
  offset_order: number;
  territory: InsTerritory | null;
  time_period: InsTimePeriod | null;
  classification_value: InsClassificationValue | null;
  unit: InsUnit | null;
}

export interface InsDimensionValueFilter {
  search?: string;
}

export interface InsDimensionValuePageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface InsDimensionValueConnection {
  nodes: InsDimensionValue[];
  pageInfo: InsDimensionValuePageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Entities
// ─────────────────────────────────────────────────────────────────────────────

export interface InsTerritory {
  id: number;
  code: string;
  siruta_code: string | null;
  level: InsTerritoryLevel;
  name_ro: string;
  path: string | null;
  parent_id: number | null;
}

export interface InsTimePeriod {
  id: number;
  year: number;
  quarter: number | null;
  month: number | null;
  periodicity: InsPeriodicity;
  period_start: Date;
  period_end: Date;
  label_ro: string | null;
  label_en: string | null;
  iso_period: string;
}

export interface InsClassificationType {
  id: number;
  code: string;
  name_ro: string | null;
  name_en: string | null;
  is_hierarchical: boolean;
  value_count: number | null;
}

export interface InsClassificationValue {
  id: number;
  type_id: number;
  type_code: string;
  type_name_ro: string | null;
  type_name_en: string | null;
  code: string;
  name_ro: string | null;
  name_en: string | null;
  level: number | null;
  parent_id: number | null;
  sort_order: number | null;
}

export interface InsUnit {
  id: number;
  code: string;
  symbol: string | null;
  name_ro: string | null;
  name_en: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observations
// ─────────────────────────────────────────────────────────────────────────────

export interface InsObservation {
  id: string;
  dataset_code: string;
  matrix_id: number;
  territory: InsTerritory | null;
  time_period: InsTimePeriod;
  unit: InsUnit | null;
  value: Decimal | null;
  value_status: string | null;
  classifications: InsClassificationValue[];
  dimensions: Record<string, unknown>;
}

export interface InsObservationFilter {
  territory_codes?: string[];
  siruta_codes?: string[];
  territory_levels?: InsTerritoryLevel[];
  unit_codes?: string[];
  classification_value_codes?: string[];
  classification_type_codes?: string[];
  periodicity?: InsPeriodicity;
  years?: number[];
  quarters?: number[];
  months?: number[];
  period?: string;
  period_range?: { start: string; end: string };
  has_value?: boolean;
}

export interface InsObservationPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface InsObservationConnection {
  nodes: InsObservation[];
  pageInfo: InsObservationPageInfo;
}

export interface ListInsObservationsInput {
  dataset_codes: string[];
  filter?: InsObservationFilter;
  limit: number;
  offset: number;
}

export interface InsEntitySelectorInput {
  siruta_code?: string;
  territory_code?: string;
  territory_level?: InsTerritoryLevel;
}

export type InsLatestMatchStrategy =
  | 'PREFERRED_CLASSIFICATION'
  | 'TOTAL_FALLBACK'
  | 'REPRESENTATIVE_FALLBACK'
  | 'NO_DATA';

export interface InsLatestDatasetValue {
  dataset: InsDataset;
  observation: InsObservation | null;
  latest_period: string | null;
  match_strategy: InsLatestMatchStrategy;
  has_data: boolean;
}

export interface ListInsLatestDatasetValuesInput {
  entity: InsEntitySelectorInput;
  dataset_codes: string[];
  preferred_classification_codes?: string[];
}

export interface InsUatIndicatorsInput {
  siruta_code: string;
  period?: string;
  dataset_codes?: string[];
}

export interface InsCompareInput {
  siruta_codes: string[];
  dataset_code: string;
  period?: string;
}

export interface InsUatDashboardInput {
  siruta_code: string;
  period?: string;
  context_code?: string;
}

export interface InsUatDatasetGroup {
  dataset: InsDataset;
  observations: InsObservation[];
  latest_period: string | null;
}

/** Max rows returned for UAT dashboard query */
export const MAX_UAT_DASHBOARD_LIMIT = 2000;
