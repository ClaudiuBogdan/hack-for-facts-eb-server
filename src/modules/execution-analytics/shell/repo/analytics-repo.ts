import { Decimal } from 'decimal.js';
import { sql, type RawBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency, type DataSeries, type DataPoint } from '@/common/types/temporal.js';
import {
  setStatementTimeout,
  CommonJoins,
  amountColumnRef,
  columnRef,
  CommonGroupBy,
  CommonOrderBy,
} from '@/infra/database/query-builders/index.js';
import {
  createFilterContext,
  buildPeriodConditions,
  buildDimensionConditions,
  buildCodeConditions,
  buildEntityConditions,
  buildUatConditions,
  buildExclusionConditions,
  buildAmountConditions,
  andConditions,
  needsEntityJoin,
  needsUatJoin,
  formatDateFromRow,
  type SqlCondition,
} from '@/infra/database/query-filters/index.js';

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

    // Determine join requirements
    const hasEntityJoin = needsEntityJoin(filter);
    const hasUatJoin = needsUatJoin(filter);

    // Create filter context
    const ctx = createFilterContext({
      hasEntityJoin,
      hasUatJoin,
    });

    try {
      // Set statement timeout for this transaction
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // Build WHERE conditions using composable filter pipeline (parameterized)
      const conditions = this.buildAllConditions(filter, frequency, ctx);
      const whereCondition = andConditions(conditions);

      // Build join clauses using CommonJoins
      const entityJoinClause = hasEntityJoin ? CommonJoins.entityOnLineItem() : sql``;
      const uatJoinClause = hasUatJoin ? CommonJoins.uatOnEntity() : sql``;

      // Get aggregation expressions based on frequency
      let periodCol: RawBuilder<unknown>;
      let groupBy: RawBuilder<unknown>;
      let orderBy: RawBuilder<unknown>;

      if (frequency === Frequency.MONTH) {
        periodCol = columnRef('eli', 'month');
        groupBy = CommonGroupBy.yearMonth();
        orderBy = CommonOrderBy.yearMonthAsc();
      } else if (frequency === Frequency.QUARTER) {
        periodCol = columnRef('eli', 'quarter');
        groupBy = CommonGroupBy.yearQuarter();
        orderBy = CommonOrderBy.yearQuarterAsc();
      } else {
        // YEAR
        periodCol = columnRef('eli', 'year');
        groupBy = CommonGroupBy.year();
        orderBy = CommonOrderBy.yearAsc();
      }

      // Safe amount column reference
      const amountColRef = amountColumnRef('eli', frequency);

      // Build and execute query with parameterized WHERE clause
      const queryText = sql`
        SELECT
          eli.year,
          ${periodCol} AS period_value,
          COALESCE(SUM(${amountColRef}), 0) AS amount
        FROM executionlineitems eli
        ${entityJoinClause}
        ${uatJoinClause}
        WHERE ${whereCondition}
        GROUP BY ${groupBy}
        ORDER BY ${orderBy}
        LIMIT ${MAX_DATA_POINTS}
      `;

      const result = await queryText.execute(this.db);
      const rows = result.rows as AggregatedRow[];

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
   * Builds all WHERE conditions using the composable filter pipeline.
   * Returns parameterized SqlCondition RawBuilders for SQL injection prevention.
   */
  private buildAllConditions(
    filter: AnalyticsFilter,
    frequency: Frequency,
    ctx: ReturnType<typeof createFilterContext>
  ): SqlCondition[] {
    const conditions: SqlCondition[] = [];

    // Period conditions (date range, discrete dates)
    conditions.push(...buildPeriodConditions(filter.report_period.selection, frequency, ctx));

    // Dimension conditions (account_category, report_type, entity_cuis, etc.)
    conditions.push(...buildDimensionConditions(filter, ctx));

    // Code conditions (functional, economic, program codes)
    conditions.push(...buildCodeConditions(filter, ctx));

    // Entity conditions (if joined)
    if (ctx.hasEntityJoin) {
      conditions.push(...buildEntityConditions(filter, ctx));
    }

    // UAT conditions (if joined)
    if (ctx.hasUatJoin) {
      conditions.push(...buildUatConditions(filter, ctx));
    }

    // Amount constraints
    conditions.push(...buildAmountConditions(filter, frequency, ctx));

    // Exclusion conditions
    if (filter.exclude !== undefined) {
      conditions.push(...buildExclusionConditions(filter.exclude, filter.account_category, ctx));
    }

    return conditions;
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
