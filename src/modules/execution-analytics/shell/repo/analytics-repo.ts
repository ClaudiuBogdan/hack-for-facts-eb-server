/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires any typing */
import { Decimal } from 'decimal.js';
import { sql, type ExpressionBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { type DataSeries, type DataPoint } from '@/common/types/temporal.js';

import {
  formatDateFromRow,
  getFrequency,
  extractYear,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
  type PeriodType,
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
    const periodType = filter.report_period.type;

    try {
      // Set statement timeout for this transaction
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build query step by step
      let query: DynamicQuery = this.db
        .selectFrom('executionlineitems as eli')
        .select(['eli.year']);

      query = this.applyPeriodAggregation(query, periodType);
      query = this.applyPeriodFilters(query, filter);
      query = this.applyDimensionFilters(query, filter);
      query = this.applyCodeFilters(query, filter);
      query = this.applyEntityJoinsAndFilters(query, filter);
      query = this.applyExclusions(query, filter);
      query = this.applyAmountConstraints(query, filter);

      // Apply safety limit
      query = query.limit(MAX_DATA_POINTS);

      // Execute query
      const rows: AggregatedRow[] = await query.execute();

      // Transform to DataSeries
      const dataPoints = this.transformRowsToDataPoints(rows, periodType);

      const series: DataSeries = {
        frequency: getFrequency(periodType),
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
  private applyPeriodAggregation(query: DynamicQuery, periodType: PeriodType): DynamicQuery {
    if (periodType === 'MONTH') {
      return query
        .select('eli.month as period_value')
        .select(sql<string>`COALESCE(SUM(eli.monthly_amount), 0)`.as('amount'))
        .groupBy(['eli.year', 'eli.month'])
        .orderBy('eli.year', 'asc')
        .orderBy('eli.month', 'asc');
    }

    if (periodType === 'QUARTER') {
      return query
        .select('eli.quarter as period_value')
        .select(sql<string>`COALESCE(SUM(eli.quarterly_amount), 0)`.as('amount'))
        .groupBy(['eli.year', 'eli.quarter'])
        .orderBy('eli.year', 'asc')
        .orderBy('eli.quarter', 'asc')
        .where('eli.is_quarterly', '=', true);
    }

    // YEAR
    return query
      .select('eli.year as period_value')
      .select(sql<string>`COALESCE(SUM(eli.ytd_amount), 0)`.as('amount'))
      .groupBy('eli.year')
      .orderBy('eli.year', 'asc')
      .where('eli.is_yearly', '=', true);
  }

  /**
   * Applies period (date range) filters.
   */
  private applyPeriodFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    const { selection } = filter.report_period;

    // Interval-based filter
    if (selection.interval !== undefined) {
      const startYear = extractYear(selection.interval.start);
      const endYear = extractYear(selection.interval.end);

      if (startYear !== null) {
        query = query.where('eli.year', '>=', startYear);
      }
      if (endYear !== null) {
        query = query.where('eli.year', '<=', endYear);
      }
    }

    // Discrete dates filter
    if (selection.dates !== undefined && selection.dates.length > 0) {
      const years = selection.dates
        .map((d) => extractYear(d))
        .filter((y): y is number => y !== null);

      if (years.length > 0) {
        query = query.where('eli.year', 'in', years);
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
    }

    // Apply UAT join if needed (depends on entity join)
    if (requiresUatJoin) {
      query = query.leftJoin('uats as u', 'e.uat_id', 'u.id');

      if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
        query = query.where('u.county_code', 'in', filter.county_codes);
      }
    }

    return query;
  }

  /**
   * Applies exclusion filters.
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

    if (ex.functional_prefixes !== undefined && ex.functional_prefixes.length > 0) {
      const prefixes = ex.functional_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
        return eb.not(eb.or(ors));
      });
    }

    if (ex.entity_types !== undefined && ex.entity_types.length > 0) {
      query = query.where('e.entity_type', 'not in', ex.entity_types);
    }

    if (ex.county_codes !== undefined && ex.county_codes.length > 0) {
      query = query.where('u.county_code', 'not in', ex.county_codes);
    }

    return query;
  }

  /**
   * Applies amount-based constraints.
   */
  private applyAmountConstraints(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    if (filter.item_min_amount !== undefined) {
      query = query.where('eli.ytd_amount', '>=', String(filter.item_min_amount));
    }

    if (filter.item_max_amount !== undefined) {
      query = query.where('eli.ytd_amount', '<=', String(filter.item_max_amount));
    }

    return query;
  }

  // ==========================================================================
  // Result Transformation
  // ==========================================================================

  /**
   * Transforms raw database rows to DataPoint array.
   */
  private transformRowsToDataPoints(rows: AggregatedRow[], periodType: PeriodType): DataPoint[] {
    return rows.map((r) => ({
      date: formatDateFromRow(r.year, r.period_value, periodType),
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
