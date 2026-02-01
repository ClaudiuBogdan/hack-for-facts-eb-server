// Ignore naming conventions for database tables

import { ColumnType, Generated } from 'kysely';

// Enum Types
export type Periodicity = 'ANNUAL' | 'QUARTERLY' | 'MONTHLY';
export type TerritoryLevel = 'NATIONAL' | 'NUTS1' | 'NUTS2' | 'NUTS3' | 'LAU';
export type SyncStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'STALE';
export type DimensionType = 'TEMPORAL' | 'TERRITORIAL' | 'CLASSIFICATION' | 'UNIT_OF_MEASURE';
export type SyncTaskStatus =
  | 'PENDING'
  | 'PLANNING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';
export type SyncChunkStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXHAUSTED'
  | 'SKIPPED';
export type ContextChildrenType = 'context' | 'matrix';

// Helper for timestamps which can be strings or Dates depending on driver config
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type JsonValue = Record<string, unknown>;

// Contexts
export interface Contexts {
  id: Generated<number>;
  ins_code: string;
  names: JsonValue;
  level: number | null;
  parent_id: number | null;
  path: string;
  children_type: ContextChildrenType | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Territories
export interface Territories {
  id: Generated<number>;
  code: string;
  siruta_code: string | null;
  level: TerritoryLevel;
  path: string;
  parent_id: number | null;
  name: string;
  siruta_metadata: JsonValue | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Time periods
export interface TimePeriods {
  id: Generated<number>;
  year: number;
  quarter: number | null;
  month: number | null;
  periodicity: Periodicity;
  period_start: ColumnType<Date, Date | string, Date | string>;
  period_end: ColumnType<Date, Date | string, Date | string>;
  labels: JsonValue;
  created_at: Generated<Timestamp>;
}

// Classification types
export interface ClassificationTypes {
  id: Generated<number>;
  code: string;
  names: JsonValue;
  is_hierarchical: Generated<boolean>;
  label_patterns: string[] | null;
  created_at: Generated<Timestamp>;
}

// Classification values
export interface ClassificationValues {
  id: Generated<number>;
  type_id: number;
  code: string;
  content_hash: string;
  path: string | null;
  parent_id: number | null;
  level: number | null;
  names: JsonValue;
  sort_order: number | null;
  created_at: Generated<Timestamp>;
}

// Units of measure
export interface UnitsOfMeasure {
  id: Generated<number>;
  code: string;
  symbol: string | null;
  names: JsonValue;
  label_patterns: string[] | null;
  created_at: Generated<Timestamp>;
}

// Matrices
export interface Matrices {
  id: Generated<number>;
  ins_code: string;
  context_id: number | null;
  metadata: JsonValue;
  dimensions: JsonValue | null;
  sync_status: SyncStatus | null;
  last_sync_at: Timestamp | null;
  sync_error: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Matrix dimensions
export interface MatrixDimensions {
  id: Generated<number>;
  matrix_id: number;
  dim_index: number;
  dimension_type: DimensionType;
  labels: JsonValue;
  classification_type_id: number | null;
  is_hierarchical: Generated<boolean>;
  option_count: number | null;
  created_at: Generated<Timestamp>;
}

// Matrix nom items
export interface MatrixNomItems {
  id: Generated<number>;
  matrix_id: number;
  dim_index: number;
  nom_item_id: number;
  dimension_type: DimensionType;
  territory_id: number | null;
  time_period_id: number | null;
  classification_value_id: number | null;
  unit_id: number | null;
  labels: JsonValue;
  parent_nom_item_id: number | null;
  offset_order: number;
  created_at: Generated<Timestamp>;
}

// Label mappings
export interface LabelMappings {
  id: Generated<number>;
  label_normalized: string;
  label_original: string;
  context_type: string;
  context_hint: string;
  territory_id: number | null;
  time_period_id: number | null;
  classification_value_id: number | null;
  unit_id: number | null;
  resolution_method: string | null;
  confidence: string | null;
  is_unresolvable: Generated<boolean>;
  unresolvable_reason: string | null;
  created_at: Generated<Timestamp>;
  resolved_at: Timestamp | null;
}

// Statistics
export interface Statistics {
  id: Generated<string>;
  matrix_id: number;
  territory_id: number | null;
  time_period_id: number;
  unit_id: number | null;
  value: string | null;
  value_status: string | null;
  natural_key_hash: string;
  source_enc_query: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  version: number | null;
}

// Statistic classifications
export interface StatisticClassifications {
  matrix_id: number;
  statistic_id: string;
  classification_value_id: number;
}

// Sync tasks
export interface SyncTasks {
  id: Generated<number>;
  matrix_id: number;
  year_from: number;
  year_to: number;
  classification_mode: string;
  county_code: string | null;
  status: SyncTaskStatus;
  priority: number;
  chunks_total: number | null;
  chunks_completed: number;
  chunks_failed: number;
  rows_inserted: number;
  rows_updated: number;
  created_at: Generated<Timestamp>;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  error_message: string | null;
  locked_until: Timestamp | null;
  locked_by: string | null;
  created_by: string;
}

// Sync checkpoints
export interface SyncCheckpoints {
  id: Generated<number>;
  task_id: number | null;
  matrix_id: number;
  chunk_hash: string;
  chunk_index: number;
  chunk_name: string;
  county_code: string | null;
  year_from: number | null;
  year_to: number | null;
  cells_estimated: number;
  status: SyncChunkStatus;
  cells_returned: number | null;
  rows_synced: number | null;
  created_at: Generated<Timestamp>;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  error_message: string | null;
  retry_count: number;
  next_retry_at: Timestamp | null;
  locked_until: Timestamp | null;
  locked_by: string | null;
}

// Sync rate limiter
export interface SyncRateLimiter {
  id: number;
  locked_until: Timestamp | null;
  locked_by: string | null;
  min_interval_ms: number;
  last_call_at: Timestamp | null;
  calls_today: number;
  stats_reset_at: ColumnType<Date, Date | string, Date | string>;
}

// Matrix tags
export interface MatrixTags {
  id: Generated<number>;
  name: string;
  name_en: string | null;
  slug: string;
  category: string;
  description: string | null;
  usage_count: number | null;
  created_at: Generated<Timestamp>;
}

// Matrix tag assignments
export interface MatrixTagAssignments {
  matrix_id: number;
  tag_id: number;
}

// Matrix relationships
export interface MatrixRelationships {
  id: Generated<number>;
  matrix_id: number;
  related_matrix_id: number;
  relationship_type: string;
  notes: string | null;
  created_at: Generated<Timestamp>;
}

// Data quality metrics
export interface DataQualityMetrics {
  id: Generated<number>;
  matrix_id: number;
  territory_id: number | null;
  year: number | null;
  expected_data_points: number | null;
  actual_data_points: number | null;
  null_count: number | null;
  unavailable_count: number | null;
  computed_at: Generated<Timestamp>;
}

// Saved queries
export interface SavedQueries {
  id: Generated<number>;
  name: string;
  description: string | null;
  matrix_code: string;
  territory_filter: JsonValue | null;
  time_filter: JsonValue | null;
  classification_filter: JsonValue | null;
  options: JsonValue | null;
  is_public: Generated<boolean>;
  execution_count: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Composite indicators
export interface CompositeIndicators {
  id: Generated<number>;
  code: string;
  name: string;
  name_en: string | null;
  formula: string;
  unit_code: string | null;
  config: JsonValue;
  category: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Views
export interface VMatrices {
  id: number;
  ins_code: string;
  name_ro: string | null;
  name_en: string | null;
  definition_ro: string | null;
  definition_en: string | null;
  start_year: number | null;
  end_year: number | null;
  has_uat_data: boolean | null;
  has_county_data: boolean | null;
  has_siruta: boolean | null;
  periodicity: JsonValue | null;
  dimension_count: number;
  sync_status: SyncStatus | null;
  last_sync_at: Timestamp | null;
  context_code: string | null;
  context_name_ro: string | null;
  context_name_en: string | null;
  context_path: string | null;
}

export interface VTerritories {
  id: number;
  code: string;
  siruta_code: string | null;
  level: TerritoryLevel;
  path: string;
  name_ro: string;
  name_en: string | null;
  name_normalized: string;
  parent_id: number | null;
  parent_code: string | null;
  parent_name_ro: string | null;
  siruta_metadata: JsonValue | null;
}

export interface VContexts {
  id: number;
  ins_code: string;
  name_ro: string | null;
  name_en: string | null;
  level: number | null;
  path: string;
  parent_id: number | null;
  parent_code: string | null;
  parent_name_ro: string | null;
  children_type: ContextChildrenType | null;
  child_count: number;
  matrix_count: number;
}

export interface VClassificationTypes {
  id: number;
  code: string;
  name_ro: string | null;
  name_en: string | null;
  is_hierarchical: boolean | null;
  value_count: number;
}

export interface VTimePeriods {
  id: number;
  year: number;
  quarter: number | null;
  month: number | null;
  periodicity: Periodicity;
  period_start: ColumnType<Date, Date | string, Date | string>;
  period_end: ColumnType<Date, Date | string, Date | string>;
  label_ro: string | null;
  label_en: string | null;
  iso_period: string | null;
}

export interface VUnits {
  id: number;
  code: string;
  symbol: string | null;
  name_ro: string | null;
  name_en: string | null;
  name_normalized: string | null;
}

export interface VUnresolvedLabels {
  id: number;
  label_original: string;
  label_normalized: string;
  context_type: string;
  context_hint: string;
  unresolvable_reason: string | null;
  created_at: Timestamp;
}

export interface VSyncTasks {
  id: number;
  matrix_id: number;
  matrix_code: string;
  matrix_name: string | null;
  year_from: number;
  year_to: number;
  classification_mode: string;
  county_code: string | null;
  status: SyncTaskStatus;
  priority: number;
  chunks_total: number | null;
  chunks_completed: number | null;
  chunks_failed: number | null;
  progress_pct: string | null;
  rows_inserted: number | null;
  rows_updated: number | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  error_message: string | null;
  locked_until: Timestamp | null;
  locked_by: string | null;
  created_by: string;
  is_locked: boolean;
}

export interface VSyncCheckpoints {
  id: number;
  task_id: number | null;
  matrix_id: number;
  matrix_code: string;
  chunk_hash: string;
  chunk_index: number;
  chunk_name: string;
  county_code: string | null;
  year_from: number | null;
  year_to: number | null;
  cells_estimated: number;
  status: SyncChunkStatus;
  cells_returned: number | null;
  rows_synced: number | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  error_message: string | null;
  retry_count: number;
  next_retry_at: Timestamp | null;
  locked_until: Timestamp | null;
  locked_by: string | null;
  is_locked: boolean;
}

export interface VSyncTaskSummary {
  status: SyncTaskStatus;
  task_count: number;
  total_chunks: number | null;
  completed_chunks: number | null;
  failed_chunks: number | null;
  total_rows_inserted: number | null;
  total_rows_updated: number | null;
}

export interface VSyncFailedChunks {
  id: number;
  task_id: number | null;
  task_status: SyncTaskStatus | null;
  matrix_code: string;
  chunk_name: string;
  error_message: string | null;
  retry_count: number;
  next_retry_at: Timestamp | null;
  ready_to_retry: boolean;
}

export interface VMatrixSyncStatus {
  matrix_id: number;
  ins_code: string;
  name_ro: string | null;
  dimension_count: number;
  has_uat_data: boolean | null;
  has_county_data: boolean | null;
  available_year_from: number | null;
  available_year_to: number | null;
  sync_status: SyncStatus | null;
  last_sync_at: Timestamp | null;
  sync_error: string | null;
  task_id: number | null;
  task_status: SyncTaskStatus | null;
  task_year_from: number | null;
  task_year_to: number | null;
  classification_mode: string | null;
  task_county: string | null;
  chunks_total: number | null;
  chunks_completed: number | null;
  chunks_failed: number | null;
  task_progress_pct: string | null;
  task_rows_inserted: number | null;
  task_rows_updated: number | null;
  task_created_at: Timestamp | null;
  task_completed_at: Timestamp | null;
  task_error: string | null;
  data_rows: number | null;
  data_territories: number | null;
  data_year_min: number | null;
  data_year_max: number | null;
  data_years_count: number | null;
  data_last_updated: Timestamp | null;
  history_completed: number | null;
  history_failed: number | null;
  history_active: number | null;
  overall_status: string;
}

export interface MvNationalTimeseries {
  matrix_id: number;
  year: number;
  periodicity: Periodicity;
  data_point_count: number;
  avg_value: string | null;
  sum_value: string | null;
  min_value: string | null;
  max_value: string | null;
  null_count: number;
}

export interface MvAnnualNuts2Totals {
  matrix_id: number;
  territory_id: number;
  territory_code: string;
  territory_name: string;
  year: number;
  data_point_count: number;
  total_value: string | null;
  avg_value: string | null;
}

export interface MvMatrixStats {
  matrix_id: number;
  ins_code: string;
  total_records: number | null;
  territory_count: number | null;
  time_period_count: number | null;
  min_year: number | null;
  max_year: number | null;
  non_null_count: number | null;
  null_count: number | null;
  last_data_update: Timestamp | null;
}

// Database Schema Interface
// Note: PostgreSQL converts unquoted identifiers to lowercase, so table names here must be lowercase
export interface InsDatabase {
  contexts: Contexts;
  territories: Territories;
  time_periods: TimePeriods;
  classification_types: ClassificationTypes;
  classification_values: ClassificationValues;
  units_of_measure: UnitsOfMeasure;
  matrices: Matrices;
  matrix_dimensions: MatrixDimensions;
  matrix_nom_items: MatrixNomItems;
  label_mappings: LabelMappings;
  statistics: Statistics;
  statistic_classifications: StatisticClassifications;
  sync_tasks: SyncTasks;
  sync_checkpoints: SyncCheckpoints;
  sync_rate_limiter: SyncRateLimiter;
  matrix_tags: MatrixTags;
  matrix_tag_assignments: MatrixTagAssignments;
  matrix_relationships: MatrixRelationships;
  data_quality_metrics: DataQualityMetrics;
  saved_queries: SavedQueries;
  composite_indicators: CompositeIndicators;
  v_matrices: VMatrices;
  v_territories: VTerritories;
  v_contexts: VContexts;
  v_classification_types: VClassificationTypes;
  v_time_periods: VTimePeriods;
  v_units: VUnits;
  v_unresolved_labels: VUnresolvedLabels;
  v_sync_tasks: VSyncTasks;
  v_sync_checkpoints: VSyncCheckpoints;
  v_sync_task_summary: VSyncTaskSummary;
  v_sync_failed_chunks: VSyncFailedChunks;
  v_matrix_sync_status: VMatrixSyncStatus;
  mv_national_timeseries: MvNationalTimeseries;
  mv_annual_nuts2_totals: MvAnnualNuts2Totals;
  mv_matrix_stats: MvMatrixStats;
}
