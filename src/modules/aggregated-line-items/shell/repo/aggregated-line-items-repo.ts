import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import {
  setStatementTimeout,
  CommonJoins,
  coalesceEconomicCode,
  coalesceEconomicName,
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
  getAmountColumnName,
  andConditions,
  needsEntityJoin,
  needsUatJoin,
  type SqlCondition,
} from '@/infra/database/query-filters/index.js';

import {
  createDatabaseError,
  createTimeoutError,
  type AggregatedLineItemsError,
} from '../../core/errors.js';
import {
  MAX_DB_ROWS,
  type ClassificationPeriodData,
  type ClassificationPeriodResult,
  type NormalizedAggregatedResult,
  type PeriodFactorMap,
  type AggregateFilters,
  type PaginationParams,
  type AggregatedClassification,
} from '../../core/types.js';

import type { AggregatedLineItemsRepository } from '../../core/ports.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Constants
// ============================================================================

/** Query timeout in milliseconds (30 seconds) */
const QUERY_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Raw row returned from the aggregation query.
 */
interface RawAggregatedRow {
  functional_code: string;
  functional_name: string;
  economic_code: string;
  economic_name: string;
  year: number;
  amount: string; // NUMERIC comes as string
  count: string; // COUNT comes as string in some drivers
}

/**
 * Raw row returned from the normalized aggregation query.
 */
interface RawNormalizedRow {
  functional_code: string;
  functional_name: string;
  economic_code: string;
  economic_name: string;
  normalized_amount: string; // NUMERIC comes as string
  count: string; // COUNT comes as string in some drivers
  total_count: string; // Window function result
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Kysely-based implementation of AggregatedLineItemsRepository.
 *
 * IMPORTANT: This repository implements the aggregate-after-normalize pattern.
 *
 * It returns data grouped by (classification, year) to allow the use case
 * to apply year-specific normalization factors before final aggregation.
 *
 * DATA FORMAT
 * -----------
 * - Values are in nominal RON (no inflation adjustment)
 * - Each row represents the SUM of matching records for that classification+year
 * - Rows are not sorted or paginated (handled by use case after normalization)
 */
export class KyselyAggregatedLineItemsRepo implements AggregatedLineItemsRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getClassificationPeriodData(
    filter: AnalyticsFilter
  ): Promise<Result<ClassificationPeriodResult, AggregatedLineItemsError>> {
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
      // Set statement timeout
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // Build WHERE conditions using composable filter pipeline (parameterized)
      const conditions = this.buildAllConditions(filter, frequency, ctx);
      const whereCondition = andConditions(conditions);

      // Build join clauses using CommonJoins
      const entityJoinClause = hasEntityJoin ? CommonJoins.entityOnLineItem() : sql``;
      const uatJoinClause = hasUatJoin ? CommonJoins.uatOnEntity() : sql``;

      // Get amount column based on frequency (static internal value)
      const amountColumn = getAmountColumnName(frequency);

      // Get frequency flag for quarterly/yearly (static SQL)
      const frequencyFlag = this.getFrequencyFlag(frequency);

      // Build safe raw expressions for static SQL fragments
      // eslint-disable-next-line no-restricted-syntax -- Safe: amountColumn from getAmountColumnName
      const amountColRaw = sql.raw(`eli.${amountColumn}`);
      // eslint-disable-next-line no-restricted-syntax -- Safe: frequencyFlag from getFrequencyFlag
      const frequencyFlagRaw = frequencyFlag !== '' ? sql.raw(frequencyFlag) : sql``;

      // Use pre-built COALESCE expressions from query-builders
      const economicCodeExpr = coalesceEconomicCode();
      const economicNameExpr = coalesceEconomicName();

      // Build and execute query with parameterized WHERE clause
      const queryText = sql`
        SELECT
          fc.functional_code,
          fc.functional_name,
          ${economicCodeExpr} AS economic_code,
          ${economicNameExpr} AS economic_name,
          eli.year,
          COALESCE(SUM(${amountColRaw}), 0) AS amount,
          COUNT(*) AS count
        FROM executionlineitems eli
        INNER JOIN functionalclassifications fc ON eli.functional_code = fc.functional_code
        LEFT JOIN economicclassifications ec ON eli.economic_code = ec.economic_code
        ${entityJoinClause}
        ${uatJoinClause}
        WHERE ${whereCondition}
        ${frequencyFlagRaw}
        GROUP BY
          fc.functional_code,
          fc.functional_name,
          ${economicCodeExpr},
          ${economicNameExpr},
          eli.year
        LIMIT ${MAX_DB_ROWS}
      `;

      // Execute query
      const result = await queryText.execute(this.db);
      const rows = result.rows as RawAggregatedRow[];

      // Transform to domain types
      const data = this.transformRows(rows);

      // Count distinct classifications
      const distinctClassifications = new Set(
        data.map((r) => `${r.functional_code}|${r.economic_code}`)
      );

      return ok({
        rows: data,
        distinctClassificationCount: distinctClassifications.size,
      });
    } catch (error) {
      return this.handleQueryError(error);
    }
  }

  /**
   * Fetches aggregated line items with SQL-level normalization, sorting, and pagination.
   *
   * Uses a VALUES CTE to pass pre-computed multipliers to PostgreSQL:
   * ```sql
   * WITH factors(period_key, multiplier) AS (VALUES ...)
   * SELECT ..., SUM(amount * f.multiplier) AS normalized_amount
   * FROM ... INNER JOIN factors f ON eli.year = f.period_key
   * GROUP BY ... ORDER BY normalized_amount DESC
   * LIMIT $limit OFFSET $offset
   * ```
   */
  async getNormalizedAggregatedItems(
    filter: AnalyticsFilter,
    factorMap: PeriodFactorMap,
    pagination: PaginationParams,
    aggregateFilters?: AggregateFilters
  ): Promise<Result<NormalizedAggregatedResult, AggregatedLineItemsError>> {
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
      // Set statement timeout
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // Handle empty factor map
      if (factorMap.size === 0) {
        return ok({ items: [], totalCount: 0 });
      }

      // Build VALUES clause for factors CTE
      const factorValues = this.buildFactorValuesCTE(factorMap);

      // Get the appropriate amount column based on frequency (static internal value)
      const amountColumn = getAmountColumnName(frequency);

      // Build safe raw expression for normalized amount
      // eslint-disable-next-line no-restricted-syntax -- Safe: amountColumn from getAmountColumnName
      const normalizedAmountExpr = sql.raw(`COALESCE(SUM(eli.${amountColumn} * f.multiplier), 0)`);

      // Build join clauses using CommonJoins
      const entityJoinClause = hasEntityJoin ? CommonJoins.entityOnLineItem() : sql``;
      const uatJoinClause = hasUatJoin ? CommonJoins.uatOnEntity() : sql``;

      // Use pre-built COALESCE expressions from query-builders
      const economicCodeExpr = coalesceEconomicCode();
      const economicNameExpr = coalesceEconomicName();

      // Build WHERE conditions using composable filter pipeline (parameterized)
      const conditions = this.buildAllConditions(filter, frequency, ctx);
      const whereCondition = andConditions(conditions);

      // Build HAVING conditions
      const havingConditions = this.buildHavingConditions(aggregateFilters);

      // Build the complete query with CTE
      const queryText = sql`
        WITH factors(period_key, multiplier) AS (
          VALUES ${factorValues}
        )
        SELECT
          fc.functional_code,
          fc.functional_name,
          ${economicCodeExpr} AS economic_code,
          ${economicNameExpr} AS economic_name,
          ${normalizedAmountExpr} AS normalized_amount,
          COUNT(*) AS count,
          COUNT(*) OVER() AS total_count
        FROM executionlineitems eli
        INNER JOIN functionalclassifications fc ON eli.functional_code = fc.functional_code
        LEFT JOIN economicclassifications ec ON eli.economic_code = ec.economic_code
        INNER JOIN factors f ON eli.year::text = f.period_key
        ${entityJoinClause}
        ${uatJoinClause}
        WHERE ${whereCondition}
        GROUP BY
          fc.functional_code,
          fc.functional_name,
          ${economicCodeExpr},
          ${economicNameExpr}
        ${havingConditions ?? sql``}
        ORDER BY normalized_amount DESC
        LIMIT ${pagination.limit} OFFSET ${pagination.offset}
      `;

      // Execute query
      const result = await queryText.execute(this.db);
      const rows = result.rows as RawNormalizedRow[];

      // Transform to domain types
      const items = this.transformNormalizedRows(rows);
      const firstRow = rows[0];
      const totalCount = firstRow !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

      return ok({ items, totalCount });
    } catch (error) {
      return this.handleNormalizedQueryError(error);
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
   * Gets the frequency flag WHERE condition for quarterly/yearly data.
   */
  private getFrequencyFlag(frequency: Frequency): string {
    if (frequency === Frequency.QUARTER) {
      return 'AND eli.is_quarterly = true';
    }
    if (frequency === Frequency.YEAR) {
      return 'AND eli.is_yearly = true';
    }
    return ''; // MONTH has no flag
  }

  /**
   * Builds a VALUES clause for the factors CTE.
   *
   * Creates: ('2020', 1.234567890123456789::numeric), ('2021', 1.198::numeric), ...
   */
  private buildFactorValuesCTE(factorMap: PeriodFactorMap): ReturnType<typeof sql> {
    const entries = Array.from(factorMap.entries());

    const valuesList = entries.map(
      ([period, mult]) => sql`(${period}, ${mult.toString()}::numeric)`
    );

    return sql.join(valuesList, sql`, `);
  }

  /**
   * Builds HAVING conditions for aggregate filters.
   *
   * Returns a RawBuilder for the HAVING clause, or undefined if no conditions.
   * SECURITY: Uses parameterized queries for aggregate filter values.
   */
  private buildHavingConditions(
    aggregateFilters?: AggregateFilters
  ): ReturnType<typeof sql> | undefined {
    if (aggregateFilters === undefined) {
      return undefined;
    }

    const conditions: ReturnType<typeof sql>[] = [];

    if (aggregateFilters.minAmount !== undefined) {
      conditions.push(sql`normalized_amount >= ${aggregateFilters.minAmount.toString()}::numeric`);
    }
    if (aggregateFilters.maxAmount !== undefined) {
      conditions.push(sql`normalized_amount <= ${aggregateFilters.maxAmount.toString()}::numeric`);
    }

    if (conditions.length === 0) {
      return undefined;
    }

    return sql`HAVING ${sql.join(conditions, sql` AND `)}`;
  }

  // ==========================================================================
  // Result Transformation
  // ==========================================================================

  /**
   * Transforms raw database rows to domain types.
   */
  private transformRows(rows: RawAggregatedRow[]): ClassificationPeriodData[] {
    return rows.map((row) => ({
      functional_code: row.functional_code,
      functional_name: row.functional_name,
      economic_code: row.economic_code,
      economic_name: row.economic_name,
      year: row.year,
      amount: new Decimal(row.amount),
      count: typeof row.count === 'string' ? parseInt(row.count, 10) : Number(row.count),
    }));
  }

  /**
   * Transforms raw normalized rows to domain types.
   */
  private transformNormalizedRows(rows: RawNormalizedRow[]): AggregatedClassification[] {
    return rows.map((row) => ({
      functional_code: row.functional_code,
      functional_name: row.functional_name,
      economic_code: row.economic_code,
      economic_name: row.economic_name,
      amount: new Decimal(row.normalized_amount),
      count: typeof row.count === 'string' ? Number.parseInt(row.count, 10) : Number(row.count),
    }));
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  /**
   * Handles query errors and returns appropriate error types.
   */
  private handleQueryError(
    error: unknown
  ): Result<ClassificationPeriodResult, AggregatedLineItemsError> {
    const message = error instanceof Error ? error.message : 'Unknown database error';

    // Check for timeout error
    const isTimeout =
      message.includes('statement timeout') ||
      message.includes('57014') ||
      message.includes('canceling statement due to statement timeout');

    if (isTimeout) {
      return err(createTimeoutError('Aggregation query timed out', error));
    }

    return err(createDatabaseError('Failed to fetch aggregated line items', error));
  }

  /**
   * Handles normalized query errors and returns appropriate error types.
   */
  private handleNormalizedQueryError(
    error: unknown
  ): Result<NormalizedAggregatedResult, AggregatedLineItemsError> {
    const message = error instanceof Error ? error.message : 'Unknown database error';

    // Check for timeout error
    const isTimeout =
      message.includes('statement timeout') ||
      message.includes('57014') ||
      message.includes('canceling statement due to statement timeout');

    if (isTimeout) {
      return err(createTimeoutError('Normalized aggregation query timed out', error));
    }

    return err(createDatabaseError('Failed to fetch normalized aggregated line items', error));
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an AggregatedLineItemsRepository instance.
 */
export const makeAggregatedLineItemsRepo = (db: BudgetDbClient): AggregatedLineItemsRepository => {
  return new KyselyAggregatedLineItemsRepo(db);
};
