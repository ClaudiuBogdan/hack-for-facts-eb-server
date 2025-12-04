import type { AggregatedLineItemsError } from './errors.js';
import type {
  ClassificationPeriodResult,
  NormalizedAggregatedResult,
  PeriodFactorMap,
  AggregateFilters,
  PaginationParams,
} from './types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { Decimal } from 'decimal.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for fetching classification-period data.
 *
 * IMPORTANT: Aggregate-After-Normalize Pattern
 * --------------------------------------------
 * This repository returns per-period data, NOT pre-aggregated totals.
 *
 * This is critical because normalization factors (CPI for inflation,
 * exchange rates, GDP, population) vary by year. To correctly normalize
 * data that spans multiple years, we must:
 *
 * 1. Fetch raw data grouped by classification AND year
 * 2. Apply normalization transformations per-year in the use case
 * 3. Aggregate (sum across years) AFTER normalization
 * 4. Sort and paginate the final results
 *
 * The repository handles:
 * - Applying all WHERE clause filters
 * - Joining with classification dimension tables
 * - Grouping by (functional_code, economic_code, year)
 * - Handling NULL economic codes with defaults
 *
 * The use case handles:
 * - Normalization (inflation, currency, per_capita, percent_gdp)
 * - Final aggregation across years
 * - HAVING clause equivalents (aggregate_min_amount, aggregate_max_amount)
 * - Sorting by normalized amount
 * - Pagination
 */
export interface AggregatedLineItemsRepository {
  /**
   * Fetches line item data grouped by classification AND period (year).
   *
   * SQL equivalent:
   * ```sql
   * SELECT
   *   fc.functional_code, fc.functional_name,
   *   COALESCE(eli.economic_code, '00.00.00') AS economic_code,
   *   COALESCE(ec.economic_name, 'Unknown...') AS economic_name,
   *   eli.year,
   *   SUM(<amount_column>) AS amount,
   *   COUNT(*) AS count
   * FROM ExecutionLineItems eli
   * INNER JOIN FunctionalClassifications fc ON ...
   * LEFT JOIN EconomicClassifications ec ON ...
   * [conditional joins]
   * WHERE [filters]
   * GROUP BY functional_code, functional_name, economic_code, economic_name, year
   * ```
   *
   * Note: Does NOT apply HAVING, ORDER BY amount, or pagination.
   * Those are applied in the use case after normalization.
   *
   * @param filter - Analytics filter with all dimension and period constraints
   * @returns Per-period classification data for normalization
   */
  getClassificationPeriodData(
    filter: AnalyticsFilter
  ): Promise<Result<ClassificationPeriodResult, AggregatedLineItemsError>>;

  /**
   * Fetches aggregated line items with SQL-level normalization, sorting, and pagination.
   *
   * This method applies normalization in the database using pre-computed factor multipliers,
   * enabling correct pagination ordering for normalized amounts.
   *
   * SQL uses a VALUES CTE to pass factors:
   * ```sql
   * WITH factors(period_key, multiplier) AS (VALUES ...)
   * SELECT ..., SUM(amount * f.multiplier) AS normalized_amount
   * FROM ... INNER JOIN factors f ON eli.year = f.period_key
   * GROUP BY ... ORDER BY normalized_amount DESC
   * LIMIT $limit OFFSET $offset
   * ```
   *
   * @param filter - Analytics filter with all dimension and period constraints
   * @param factorMap - Pre-computed combined multipliers per period (from use case)
   * @param pagination - Limit and offset for SQL pagination
   * @param aggregateFilters - Optional min/max amount filters (applied as HAVING)
   * @returns Normalized, sorted, paginated aggregated items
   */
  getNormalizedAggregatedItems(
    filter: AnalyticsFilter,
    factorMap: PeriodFactorMap,
    pagination: PaginationParams,
    aggregateFilters?: AggregateFilters
  ): Promise<Result<NormalizedAggregatedResult, AggregatedLineItemsError>>;
}

// -----------------------------------------
// Population Repository
// -----------------------------------------

/**
 * Repository interface for computing filter-based population denominators.
 *
 * Used for per_capita normalization where the population denominator
 * depends on the entities/UATs selected by the filter, not year-specific
 * population data from datasets.
 *
 * IMPORTANT: Population for per_capita is filter-dependent (constant per query),
 * unlike CPI/exchange rates which are year-specific.
 */
export interface PopulationRepository {
  /**
   * Gets total country population (sum of county-level populations).
   *
   * Used when no entity-like filters are specified (default denominator).
   *
   * SQL logic:
   * - Bucharest (county_code = 'B'): Use SIRUTA 179132 (municipality level)
   * - Other counties: Use county-level UAT (where siruta_code = county_code)
   * - Sum across all counties (avoids double-counting sub-municipal UATs)
   *
   * @returns Total country population as Decimal
   */
  getCountryPopulation(): Promise<Result<Decimal, AggregatedLineItemsError>>;

  /**
   * Gets population for entities/UATs matching the filter.
   *
   * Handles complex cases:
   * - Entity CUIs → resolve to UAT IDs
   * - County codes → use county-level populations
   * - County councils → map to county population
   * - Deduplication (UATs in already-selected counties)
   *
   * @param filter - Analytics filter with entity constraints
   * @returns Sum of populations for matching UATs/counties
   */
  getFilteredPopulation(
    filter: AnalyticsFilter
  ): Promise<Result<Decimal, AggregatedLineItemsError>>;
}
