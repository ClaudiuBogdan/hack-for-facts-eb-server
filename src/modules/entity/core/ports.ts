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
   * Batch load entities by CUIs.
   * Used by Mercurius loaders for N+1 prevention.
   *
   * @param cuis - Array of entity CUIs
   * @returns Map of CUI to Entity (missing CUIs won't have entries)
   */
  getByIds(cuis: string[]): Promise<Result<Map<string, Entity>, EntityError>>;

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
