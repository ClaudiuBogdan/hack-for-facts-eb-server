import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency, type DataSeries, type DataPoint } from '@/common/types/temporal.js';
import { setStatementTimeout, CommonJoins } from '@/infra/database/query-builders/index.js';
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

      // Get aggregation expressions based on frequency (static SQL)
      const { periodColumn, amountColumn, groupByColumns, orderByClause, frequencyFlag } =
        this.getAggregationExpressions(frequency);

      // Build raw expressions for static SQL fragments
      // NOTE: These are internal constants, not user input - safe for sql.raw
      // eslint-disable-next-line no-restricted-syntax -- Safe: periodColumn is from getAggregationExpressions
      const periodColRaw = sql.raw(periodColumn);
      // eslint-disable-next-line no-restricted-syntax -- Safe: amountColumn is from getAggregationExpressions
      const amountColRaw = sql.raw(amountColumn);
      // eslint-disable-next-line no-restricted-syntax -- Safe: frequencyFlag is from getAggregationExpressions
      const frequencyFlagRaw = frequencyFlag !== '' ? sql.raw(frequencyFlag) : sql``;
      // eslint-disable-next-line no-restricted-syntax -- Safe: groupByColumns is from getAggregationExpressions
      const groupByRaw = sql.raw(groupByColumns);
      // eslint-disable-next-line no-restricted-syntax -- Safe: orderByClause is from getAggregationExpressions
      const orderByRaw = sql.raw(orderByClause);

      // Build and execute query with parameterized WHERE clause
      const queryText = sql`
        SELECT
          eli.year,
          ${periodColRaw} AS period_value,
          COALESCE(SUM(${amountColRaw}), 0) AS amount
        FROM executionlineitems eli
        ${entityJoinClause}
        ${uatJoinClause}
        WHERE ${whereCondition}
        ${frequencyFlagRaw}
        GROUP BY ${groupByRaw}
        ORDER BY ${orderByRaw}
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

  /**
   * Gets aggregation expressions based on frequency.
   * Returns SQL fragments for SELECT, GROUP BY, ORDER BY clauses.
   */
  private getAggregationExpressions(frequency: Frequency): {
    periodColumn: string;
    amountColumn: string;
    groupByColumns: string;
    orderByClause: string;
    frequencyFlag: string;
  } {
    if (frequency === Frequency.MONTH) {
      return {
        periodColumn: 'eli.month',
        amountColumn: 'eli.monthly_amount',
        groupByColumns: 'eli.year, eli.month',
        orderByClause: 'eli.year ASC, eli.month ASC',
        frequencyFlag: '', // No flag needed for monthly
      };
    }

    if (frequency === Frequency.QUARTER) {
      return {
        periodColumn: 'eli.quarter',
        amountColumn: 'eli.quarterly_amount',
        groupByColumns: 'eli.year, eli.quarter',
        orderByClause: 'eli.year ASC, eli.quarter ASC',
        frequencyFlag: '', // Frequency flag is in WHERE conditions from buildPeriodConditions
      };
    }

    // YEARLY
    return {
      periodColumn: 'eli.year',
      amountColumn: 'eli.ytd_amount',
      groupByColumns: 'eli.year',
      orderByClause: 'eli.year ASC',
      frequencyFlag: '', // Frequency flag is in WHERE conditions from buildPeriodConditions
    };
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
