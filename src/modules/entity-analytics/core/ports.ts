import type { EntityAnalyticsError } from './errors.js';
import type {
  EntityAnalyticsResult,
  PeriodFactorMap,
  PaginationParams,
  AggregateFilters,
  EntityAnalyticsSort,
} from './types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for entity-level analytics.
 *
 * Key differences from AggregatedLineItemsRepository:
 * 1. Groups by entity_cui (not classification codes)
 * 2. Population is entity-specific (computed per row based on entity type)
 * 3. Supports multiple sort fields (not just amount DESC)
 *
 * Population Handling:
 * -------------------
 * Unlike aggregatedLineItems which uses filter-based population (constant per query),
 * entity-analytics computes population per-entity based on entity type:
 *
 * - UAT (is_uat = true): UAT's own population from uats table
 * - County Council (entity_type = 'admin_county_council'): County aggregate population
 * - Other entities: NULL population, per_capita_amount = 0
 *
 * This means the population is NOT included in the factor map - it's computed in SQL.
 */
export interface EntityAnalyticsRepository {
  /**
   * Fetches entity analytics with SQL-level normalization, sorting, and pagination.
   *
   * SQL uses a VALUES CTE to pass factors:
   * ```sql
   * WITH
   *   county_populations AS (...),
   *   factors(period_key, multiplier) AS (VALUES ...),
   *   filtered_aggregates AS (
   *     SELECT entity_cui, SUM(<amount_col> * f.multiplier) AS normalized_amount
   *     FROM executionlineitems eli
   *     INNER JOIN factors f ON eli.year::text = f.period_key
   *     WHERE [filters]
   *     GROUP BY entity_cui
   *     HAVING [aggregate filters]
   *   )
   * SELECT
   *   e.cui, e.name, e.entity_type, e.uat_id,
   *   u.county_code, u.county_name,
   *   CASE WHEN e.is_uat THEN u.population WHEN ... THEN ... ELSE NULL END AS population,
   *   fa.normalized_amount AS total_amount,
   *   COALESCE(fa.normalized_amount / NULLIF(population, 0), 0) AS per_capita_amount,
   *   COUNT(*) OVER() AS total_count
   * FROM filtered_aggregates fa
   * INNER JOIN entities e ON fa.entity_cui = e.cui
   * LEFT JOIN uats u ON e.uat_id = u.id
   * LEFT JOIN county_populations cp ON u.county_code = cp.county_code
   * ORDER BY <sort_field> <sort_order>
   * LIMIT $limit OFFSET $offset
   * ```
   *
   * @param filter - Analytics filter with all dimension and period constraints
   * @param factorMap - Pre-computed combined multipliers per period (from use case, WITHOUT population)
   * @param pagination - Limit and offset for SQL pagination
   * @param sort - Sort field and direction
   * @param aggregateFilters - Optional min/max amount filters (applied as HAVING)
   * @returns Normalized, sorted, paginated entity analytics
   */
  getEntityAnalytics(
    filter: AnalyticsFilter,
    factorMap: PeriodFactorMap,
    pagination: PaginationParams,
    sort: EntityAnalyticsSort,
    aggregateFilters?: AggregateFilters
  ): Promise<Result<EntityAnalyticsResult, EntityAnalyticsError>>;
}
