/**
 * Port interfaces for Entity module.
 *
 * Defines repository contracts that shell layer must implement.
 */

import type { EntityError } from './errors.js';
import type {
  Entity,
  EntityConnection,
  EntityFilter,
  EntityTotals,
  UAT,
  UATConnection,
  UATFilter,
  Report,
  ReportConnection,
  ReportFilter,
  ReportSort,
  ReportPeriodInput,
  DataSeries,
} from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Entity Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for entity data access.
 */
export interface EntityRepository {
  /**
   * Find a single entity by CUI.
   *
   * @param cui - The unique fiscal identification code
   * @returns The entity if found, null if not found, or an error
   */
  getById(cui: string): Promise<Result<Entity | null, EntityError>>;

  /**
   * List entities with filtering, sorting, and pagination.
   *
   * When `filter.search` is present:
   * - Uses pg_trgm similarity for full-text search
   * - Orders by prefix match, then relevance
   *
   * When `filter.search` is not present:
   * - Uses ILIKE for name/address filters
   * - Orders by cui ASC
   *
   * @param filter - Filter criteria
   * @param limit - Maximum number of results
   * @param offset - Number of results to skip
   * @returns Paginated entity connection
   */
  getAll(
    filter: EntityFilter,
    limit: number,
    offset: number
  ): Promise<Result<EntityConnection, EntityError>>;

  /**
   * Get child entities (entities where this entity is a main creditor).
   *
   * @param cui - Parent entity CUI
   * @returns List of child entities
   */
  getChildren(cui: string): Promise<Result<Entity[], EntityError>>;

  /**
   * Get parent entities (main creditors of this entity).
   *
   * @param cui - Child entity CUI
   * @returns List of parent entities
   */
  getParents(cui: string): Promise<Result<Entity[], EntityError>>;

  /**
   * Get county entity by county code.
   *
   * @param countyCode - County code
   * @returns County entity if found
   */
  getCountyEntity(countyCode: string | null): Promise<Result<Entity | null, EntityError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// UAT Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for UAT data access.
 */
export interface UATRepository {
  /**
   * Find a UAT by ID.
   *
   * @param id - UAT ID
   * @returns The UAT if found, null if not found
   */
  getById(id: number): Promise<Result<UAT | null, EntityError>>;

  /**
   * List UATs with filtering and pagination.
   *
   * Filtering:
   * - id: exact match
   * - ids: match any of these IDs
   * - uat_key: exact match
   * - uat_code: exact match
   * - name: ILIKE (when no search), or similarity (with search)
   * - county_code: exact match
   * - county_name: ILIKE (when no search), or similarity (with search)
   * - region: exact match
   * - search: pg_trgm similarity on name + county_name
   * - is_county: filter to county-level UATs (siruta_code = county_code OR Bucharest special case)
   *
   * Sorting:
   * - With search: ORDER BY similarity DESC, name ASC, id ASC
   * - Without search: ORDER BY name ASC, id ASC
   *
   * @param filter - Filter criteria
   * @param limit - Maximum number of results
   * @param offset - Number of results to skip
   * @returns Paginated UAT connection
   */
  getAll(
    filter: UATFilter,
    limit: number,
    offset: number
  ): Promise<Result<UATConnection, EntityError>>;

  /**
   * Count UATs matching filter.
   *
   * @param filter - Filter criteria
   * @returns Total count of matching UATs
   */
  count(filter: UATFilter): Promise<Result<number, EntityError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for report data access.
 */
export interface ReportRepository {
  /**
   * Get a single report by ID.
   *
   * @param reportId - The report ID to look up
   * @returns The report if found, null if not found, or an error
   */
  getById(reportId: string): Promise<Result<Report | null, EntityError>>;

  /**
   * Get a report by entity CUI and report date.
   *
   * @param entityCui - Entity CUI
   * @param reportDate - Report date
   * @returns The report if found, null if not found, or an error
   */
  getByEntityAndDate(
    entityCui: string,
    reportDate: Date
  ): Promise<Result<Report | null, EntityError>>;

  /**
   * List reports with filtering, sorting, and pagination.
   *
   * Filtering:
   * - entity_cui: exact match
   * - reporting_year: exact match
   * - reporting_period: exact match
   * - report_date_start/end: date range (inclusive)
   * - report_type: exact match (converted from GQL to DB enum)
   * - main_creditor_cui: exact match
   * - search: ILIKE on entity name and download_links
   *
   * Sorting:
   * - Default: report_date DESC, report_id DESC
   * - Only 'report_date' is allowed as sort field
   *
   * @param filter - Filter criteria
   * @param sort - Sort configuration (optional)
   * @param limit - Maximum number of results
   * @param offset - Number of results to skip
   * @returns Paginated report connection
   */
  list(
    filter: ReportFilter,
    sort: ReportSort | undefined,
    limit: number,
    offset: number
  ): Promise<Result<ReportConnection, EntityError>>;

  /**
   * Count reports matching filter.
   *
   * @param filter - Filter criteria
   * @returns Total count of matching reports
   */
  count(filter: ReportFilter): Promise<Result<number, EntityError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity Analytics Summary Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for entity analytics summary data.
 * Uses materialized views (mv_summary_*) for efficient queries.
 */
export interface EntityAnalyticsSummaryRepository {
  /**
   * Get aggregated totals for an entity over a period.
   *
   * Queries the appropriate materialized view based on period type:
   * - YEAR -> mv_summary_annual
   * - QUARTER -> mv_summary_quarterly
   * - MONTH -> mv_summary_monthly
   *
   * @param cui - Entity CUI
   * @param period - Period specification (type + selection)
   * @param reportType - Report type filter (DB enum value)
   * @param mainCreditorCui - Optional main creditor filter
   * @returns Aggregated totals (income, expenses, balance)
   */
  getTotals(
    cui: string,
    period: ReportPeriodInput,
    reportType: string,
    mainCreditorCui?: string
  ): Promise<Result<EntityTotals, EntityError>>;

  /**
   * Get financial trend data for an entity over a period.
   *
   * Returns a time series of values grouped by the period type.
   *
   * @param cui - Entity CUI
   * @param period - Period specification (type + selection)
   * @param reportType - Report type filter (DB enum value)
   * @param metric - Which metric to return ('income' | 'expenses' | 'balance')
   * @param mainCreditorCui - Optional main creditor filter
   * @returns Time series data
   */
  getTrend(
    cui: string,
    period: ReportPeriodInput,
    reportType: string,
    metric: 'income' | 'expenses' | 'balance',
    mainCreditorCui?: string
  ): Promise<Result<DataSeries, EntityError>>;
}
