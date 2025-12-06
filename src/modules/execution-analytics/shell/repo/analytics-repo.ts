/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires any typing */
import { Decimal } from 'decimal.js';
import { sql, type ExpressionBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { type DataSeries, type DataPoint } from '@/common/types/temporal.js';

import {
  formatDateFromRow,
  Frequency,
  extractYear,
  parsePeriodDate,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
} from './query-helpers.js';

import type { AnalyticsError } from '../../core/errors.js';
import type { AnalyticsRepository } from '../../core/ports.js';
import type { AnalyticsFilter } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of data points to return from a query */
const MAX_DATA_POINTS = 10_000;

/** Query timeout in milliseconds (30 seconds) */
const QUERY_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Raw row returned from aggregation query.
 * Uses snake_case to match PostgreSQL column naming.
 */
interface AggregatedRow {
  year: number;
  period_value: number;
  amount: string;
}

/**
 * Query builder type - using unknown to avoid blanket any disables.
 * Kysely's dynamic query building requires type flexibility.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely dynamic query builder
type DynamicQuery = any;

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Kysely-based implementation of AnalyticsRepository.
 *
 * IMPORTANT: This repository implements the "aggregate-after-normalize" pattern.
 *
 * It ALWAYS returns data as a time series (DataSeries) with individual
 * data points per period. This is critical because:
 *
 * 1. Normalization factors (CPI, exchange rates) vary by year
 * 2. To correctly normalize multi-year data, we must apply factors per-point
 * 3. Any cross-period aggregation must happen AFTER normalization
 *
 * DATA FORMAT
 * -----------
 * - Values are in nominal RON (no inflation adjustment)
 * - Each point represents the SUM of matching records for that period
 * - Points are ordered chronologically
 *
 * SINGLE-PERIOD QUERIES
 * ---------------------
 * When the filter specifies a single year/quarter/month, the result
 * is still a DataSeries with one data point. This maintains consistency
 * and allows the normalization pipeline to work uniformly.
 */
export class KyselyAnalyticsRepo implements AnalyticsRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getAggregatedSeries(filter: AnalyticsFilter): Promise<Result<DataSeries, AnalyticsError>> {
    const frequency = filter.report_period.type;

    try {
      // Set statement timeout for this transaction
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build query step by step
      let query: DynamicQuery = this.db
        .selectFrom('executionlineitems as eli')
        .select(['eli.year']);

      query = this.applyPeriodAggregation(query, frequency);
      query = this.applyPeriodFilters(query, filter);
      query = this.applyDimensionFilters(query, filter);
      query = this.applyCodeFilters(query, filter);
      query = this.applyEntityJoinsAndFilters(query, filter);
      query = this.applyExclusions(query, filter);
      query = this.applyAmountConstraints(query, filter, frequency);

      // Apply safety limit
      query = query.limit(MAX_DATA_POINTS);

      // Execute query
      const rows: AggregatedRow[] = await query.execute();

      // Transform to DataSeries
      const dataPoints = this.transformRowsToDataPoints(rows, frequency);

      const series: DataSeries = {
        frequency,
        data: dataPoints,
      };

      return ok(series);
    } catch (error) {
      return this.handleQueryError(error);
    }
  }

  // ==========================================================================
  // Query Building Methods
  // ==========================================================================

  /**
   * Applies period-specific SELECT, GROUP BY, and ORDER BY clauses.
   */
  private applyPeriodAggregation(query: DynamicQuery, frequency: Frequency): DynamicQuery {
    if (frequency === Frequency.MONTH) {
      return query
        .select('eli.month as period_value')
        .select(sql<string>`COALESCE(SUM(eli.monthly_amount), 0)`.as('amount'))
        .groupBy(['eli.year', 'eli.month'])
        .orderBy('eli.year', 'asc')
        .orderBy('eli.month', 'asc');
    }

    if (frequency === Frequency.QUARTER) {
      return query
        .select('eli.quarter as period_value')
        .select(sql<string>`COALESCE(SUM(eli.quarterly_amount), 0)`.as('amount'))
        .groupBy(['eli.year', 'eli.quarter'])
        .orderBy('eli.year', 'asc')
        .orderBy('eli.quarter', 'asc')
        .where('eli.is_quarterly', '=', true);
    }

    // YEARLY
    return query
      .select('eli.year as period_value')
      .select(sql<string>`COALESCE(SUM(eli.ytd_amount), 0)`.as('amount'))
      .groupBy('eli.year')
      .orderBy('eli.year', 'asc')
      .where('eli.is_yearly', '=', true);
  }

  /**
   * Applies period (date range) filters.
   *
   * IMPORTANT: Filtering must match the frequency:
   * - YEAR: Filter by year only
   * - MONTH: Filter by (year, month) tuple
   * - QUARTER: Filter by (year, quarter) tuple
   *
   * This ensures correct results when querying specific months or quarters.
   */
  private applyPeriodFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    const { selection, type: frequency } = filter.report_period;

    // Interval-based filter
    if (selection.interval !== undefined) {
      const start = parsePeriodDate(selection.interval.start);
      const end = parsePeriodDate(selection.interval.end);

      if (frequency === Frequency.MONTH && start?.month !== undefined && end?.month !== undefined) {
        // Filter by (year, month) tuple using row comparison
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.month)`, '>=', sql`(${start.year}, ${start.month})`)
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.month)`, '<=', sql`(${end.year}, ${end.month})`)
        );
      } else if (
        frequency === Frequency.QUARTER &&
        start?.quarter !== undefined &&
        end?.quarter !== undefined
      ) {
        // Filter by (year, quarter) tuple using row comparison
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.quarter)`, '>=', sql`(${start.year}, ${start.quarter})`)
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.quarter)`, '<=', sql`(${end.year}, ${end.quarter})`)
        );
      } else {
        // YEAR frequency or fallback: filter by year only
        const startYear = start?.year ?? extractYear(selection.interval.start);
        const endYear = end?.year ?? extractYear(selection.interval.end);

        if (startYear !== null) {
          query = query.where('eli.year', '>=', startYear);
        }
        if (endYear !== null) {
          query = query.where('eli.year', '<=', endYear);
        }
      }
    }

    // Discrete dates filter
    if (selection.dates !== undefined && selection.dates.length > 0) {
      if (frequency === Frequency.MONTH) {
        // Parse all dates and filter by (year, month) tuples
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; month: number } => p?.month !== undefined);

        if (validPeriods.length > 0) {
          // Use OR conditions for each (year, month) pair
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
          query = query.where((eb: ExpressionBuilder<any, any>) => {
            const conditions = validPeriods.map((p) =>
              eb.and([eb('eli.year', '=', p.year), eb('eli.month', '=', p.month)])
            );
            return eb.or(conditions);
          });
        }
      } else if (frequency === Frequency.QUARTER) {
        // Parse all dates and filter by (year, quarter) tuples
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; quarter: number } => p?.quarter !== undefined);

        if (validPeriods.length > 0) {
          // Use OR conditions for each (year, quarter) pair
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
          query = query.where((eb: ExpressionBuilder<any, any>) => {
            const conditions = validPeriods.map((p) =>
              eb.and([eb('eli.year', '=', p.year), eb('eli.quarter', '=', p.quarter)])
            );
            return eb.or(conditions);
          });
        }
      } else {
        // YEAR frequency: filter by years only
        const years = selection.dates
          .map((d) => extractYear(d))
          .filter((y): y is number => y !== null);

        if (years.length > 0) {
          query = query.where('eli.year', 'in', years);
        }
      }
    }

    return query;
  }

  /**
   * Applies dimension filters (account category, report type, entity CUIs, etc.).
   */
  private applyDimensionFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    // Required filter
    query = query.where('eli.account_category', '=', filter.account_category);

    // Optional filters
    if (filter.report_type !== undefined) {
      query = query.where('eli.report_type', '=', filter.report_type);
    }

    if (filter.main_creditor_cui !== undefined) {
      query = query.where('eli.main_creditor_cui', '=', filter.main_creditor_cui);
    }

    if (filter.report_ids !== undefined && filter.report_ids.length > 0) {
      query = query.where('eli.report_id', 'in', filter.report_ids);
    }

    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      query = query.where('eli.entity_cui', 'in', filter.entity_cuis);
    }

    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const numericIds = toNumericIds(filter.funding_source_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.funding_source_id', 'in', numericIds);
      }
    }

    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const numericIds = toNumericIds(filter.budget_sector_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.budget_sector_id', 'in', numericIds);
      }
    }

    if (filter.expense_types !== undefined && filter.expense_types.length > 0) {
      query = query.where('eli.expense_type', 'in', filter.expense_types);
    }

    return query;
  }

  /**
   * Applies code-based filters (functional, economic, program codes).
   */
  private applyCodeFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    // Exact functional codes
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      query = query.where('eli.functional_code', 'in', filter.functional_codes);
    }

    // Functional code prefixes (LIKE patterns)
    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const prefixes = filter.functional_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
        return eb.or(ors);
      });
    }

    // Exact economic codes
    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      query = query.where('eli.economic_code', 'in', filter.economic_codes);
    }

    // Economic code prefixes
    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const prefixes = filter.economic_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.economic_code', 'like', `${p}%`));
        return eb.or(ors);
      });
    }

    // Program codes
    if (filter.program_codes !== undefined && filter.program_codes.length > 0) {
      query = query.where('eli.program_code', 'in', filter.program_codes);
    }

    return query;
  }

  /**
   * Applies entity/UAT joins and their dependent filters.
   * Keeps joins and their filters together for clarity.
   */
  private applyEntityJoinsAndFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    const requiresEntityJoin = needsEntityJoin(filter);
    const requiresUatJoin = needsUatJoin(filter);

    // Apply entity join if needed
    if (requiresEntityJoin) {
      query = query.leftJoin('entities as e', 'eli.entity_cui', 'e.cui');

      // Entity-specific filters
      if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
        query = query.where('e.entity_type', 'in', filter.entity_types);
      }

      if (filter.is_uat !== undefined) {
        query = query.where('e.is_uat', '=', filter.is_uat);
      }

      if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
        const numericIds = toNumericIds(filter.uat_ids);
        if (numericIds.length > 0) {
          query = query.where('e.uat_id', 'in', numericIds);
        }
      }

      // Search filter: case-insensitive substring match on entity name
      // Escape LIKE special characters for exact substring matching
      if (filter.search !== undefined && filter.search.trim() !== '') {
        const escapedSearch = filter.search
          .trim()
          .replace(/\\/g, '\\\\') // Escape backslashes first
          .replace(/%/g, '\\%') // Escape LIKE wildcard
          .replace(/_/g, '\\_'); // Escape LIKE single-char wildcard
        query = query.where('e.name', 'ilike', `%${escapedSearch}%`);
      }
    }

    // Apply UAT join if needed (depends on entity join)
    if (requiresUatJoin) {
      query = query.leftJoin('uats as u', 'e.uat_id', 'u.id');

      if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
        query = query.where('u.county_code', 'in', filter.county_codes);
      }

      if (filter.regions !== undefined && filter.regions.length > 0) {
        query = query.where('u.region', 'in', filter.regions);
      }

      // Population filters
      if (filter.min_population !== undefined && filter.min_population !== null) {
        query = query.where('u.population', '>=', filter.min_population);
      }

      if (filter.max_population !== undefined && filter.max_population !== null) {
        query = query.where('u.population', '<=', filter.max_population);
      }
    }

    return query;
  }

  /**
   * Applies exclusion filters.
   *
   * IMPORTANT: Entity and UAT exclusions must handle NULL values correctly.
   * SQL's NOT IN does not match NULL values, so we need to explicitly include
   * rows where the column IS NULL when using NOT IN.
   *
   * Example: `entity_type NOT IN ('A', 'B')` excludes rows where entity_type IS NULL
   * Correct: `(entity_type IS NULL OR entity_type NOT IN ('A', 'B'))` preserves NULLs
   */
  private applyExclusions(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    if (filter.exclude === undefined) {
      return query;
    }

    const ex = filter.exclude;

    if (ex.report_ids !== undefined && ex.report_ids.length > 0) {
      query = query.where('eli.report_id', 'not in', ex.report_ids);
    }

    if (ex.entity_cuis !== undefined && ex.entity_cuis.length > 0) {
      query = query.where('eli.entity_cui', 'not in', ex.entity_cuis);
    }

    // Functional code exclusions
    if (ex.functional_codes !== undefined && ex.functional_codes.length > 0) {
      query = query.where('eli.functional_code', 'not in', ex.functional_codes);
    }

    if (ex.functional_prefixes !== undefined && ex.functional_prefixes.length > 0) {
      const prefixes = ex.functional_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
        return eb.not(eb.or(ors));
      });
    }

    // Economic code exclusions - only for non-VN accounts (per spec)
    if (filter.account_category !== 'vn') {
      if (ex.economic_codes !== undefined && ex.economic_codes.length > 0) {
        query = query.where('eli.economic_code', 'not in', ex.economic_codes);
      }

      if (ex.economic_prefixes !== undefined && ex.economic_prefixes.length > 0) {
        const prefixes = ex.economic_prefixes;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) => {
          const ors = prefixes.map((p) => eb('eli.economic_code', 'like', `${p}%`));
          return eb.not(eb.or(ors));
        });
      }
    }

    // Entity type exclusions - must preserve NULL entity_type rows
    if (ex.entity_types !== undefined && ex.entity_types.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('e.entity_type', 'is', null), eb('e.entity_type', 'not in', ex.entity_types)])
      );
    }

    // UAT ID exclusions - must preserve NULL uat_id rows
    if (ex.uat_ids !== undefined && ex.uat_ids.length > 0) {
      const numericIds = toNumericIds(ex.uat_ids);
      if (numericIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb.or([eb('e.uat_id', 'is', null), eb('e.uat_id', 'not in', numericIds)])
        );
      }
    }

    // County code exclusions - must preserve NULL county_code rows
    if (ex.county_codes !== undefined && ex.county_codes.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('u.county_code', 'is', null), eb('u.county_code', 'not in', ex.county_codes)])
      );
    }

    // Region exclusions - must preserve NULL region rows
    if (ex.regions !== undefined && ex.regions.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('u.region', 'is', null), eb('u.region', 'not in', ex.regions)])
      );
    }

    return query;
  }

  /**
   * Applies amount-based constraints.
   *
   * IMPORTANT: The amount column must match the selected frequency:
   * - MONTH: monthly_amount
   * - QUARTER: quarterly_amount
   * - YEAR: ytd_amount
   *
   * This ensures item_min_amount/item_max_amount filters work correctly
   * for the selected period granularity.
   */
  private applyAmountConstraints(
    query: DynamicQuery,
    filter: AnalyticsFilter,
    frequency: Frequency
  ): DynamicQuery {
    // Select the appropriate amount column based on frequency
    const amountColumn =
      frequency === Frequency.MONTH
        ? 'eli.monthly_amount'
        : frequency === Frequency.QUARTER
          ? 'eli.quarterly_amount'
          : 'eli.ytd_amount';

    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      query = query.where(sql.raw(amountColumn), '>=', String(filter.item_min_amount));
    }

    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      query = query.where(sql.raw(amountColumn), '<=', String(filter.item_max_amount));
    }

    return query;
  }

  // ==========================================================================
  // Result Transformation
  // ==========================================================================

  /**
   * Transforms raw database rows to DataPoint array.
   */
  private transformRowsToDataPoints(rows: AggregatedRow[], frequency: Frequency): DataPoint[] {
    return rows.map((r) => ({
      date: formatDateFromRow(r.year, r.period_value, frequency),
      value: new Decimal(r.amount),
    }));
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  /**
   * Handles query errors and returns appropriate AnalyticsError.
   */
  private handleQueryError(error: unknown): Result<DataSeries, AnalyticsError> {
    const message = error instanceof Error ? error.message : 'Unknown database error';

    // Check for timeout error (PostgreSQL error code 57014)
    const isTimeout =
      message.includes('statement timeout') ||
      message.includes('57014') ||
      message.includes('canceling statement due to statement timeout');

    if (isTimeout) {
      return err({
        type: 'TimeoutError',
        message: 'Analytics query timed out',
        retryable: true,
        cause: error,
      });
    }

    return err({
      type: 'DatabaseError',
      message: 'Failed to fetch analytics data',
      retryable: true,
      cause: error,
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an AnalyticsRepository instance.
 */
export const makeAnalyticsRepo = (db: BudgetDbClient): AnalyticsRepository => {
  return new KyselyAnalyticsRepo(db);
};
