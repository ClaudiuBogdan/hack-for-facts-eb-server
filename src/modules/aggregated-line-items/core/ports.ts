import type { AggregatedLineItemsError } from './errors.js';
import type { ClassificationPeriodResult } from './types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
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
}
