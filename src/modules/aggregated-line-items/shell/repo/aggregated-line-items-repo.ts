/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires any typing */
import { Decimal } from 'decimal.js';
import { sql, type ExpressionBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import {
  extractYear,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
} from '@/modules/execution-analytics/shell/repo/query-helpers.js';

import {
  createDatabaseError,
  createTimeoutError,
  type AggregatedLineItemsError,
} from '../../core/errors.js';
import {
  UNKNOWN_ECONOMIC_CODE,
  UNKNOWN_ECONOMIC_NAME,
  MAX_DB_ROWS,
  type ClassificationPeriodData,
  type ClassificationPeriodResult,
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
 * Query builder type - using unknown to avoid blanket any disables.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely dynamic query builder
type DynamicQuery = any;

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
    const frequency = filter.report_period.frequency;

    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build COALESCE expressions for economic code/name
      // These must be identical in SELECT and GROUP BY
      const economicCodeExpr = sql<string>`COALESCE(eli.economic_code, ${sql.lit(UNKNOWN_ECONOMIC_CODE)})`;
      const economicNameExpr = sql<string>`COALESCE(ec.economic_name, ${sql.lit(UNKNOWN_ECONOMIC_NAME)})`;

      // Build the query
      let query: DynamicQuery = this.db
        .selectFrom('executionlineitems as eli')
        .innerJoin('functionalclassifications as fc', 'eli.functional_code', 'fc.functional_code')
        .leftJoin('economicclassifications as ec', 'eli.economic_code', 'ec.economic_code')
        .select([
          'fc.functional_code',
          'fc.functional_name',
          economicCodeExpr.as('economic_code'),
          economicNameExpr.as('economic_name'),
          'eli.year',
        ]);

      // Add amount aggregation based on frequency
      query = this.applyAmountAggregation(query, frequency);

      // Apply all filters
      query = this.applyPeriodFilters(query, filter);
      query = this.applyDimensionFilters(query, filter);
      query = this.applyCodeFilters(query, filter);
      query = this.applyEntityJoinsAndFilters(query, filter);
      query = this.applyExclusions(query, filter);
      query = this.applyItemAmountConstraints(query, filter, frequency);

      // Group by classification + year
      // Must use same expressions as SELECT for PostgreSQL compatibility
      query = query.groupBy([
        'fc.functional_code',
        'fc.functional_name',
        economicCodeExpr,
        economicNameExpr,
        'eli.year',
      ]);

      // Safety limit
      query = query.limit(MAX_DB_ROWS);

      // Execute query
      const rows: RawAggregatedRow[] = await query.execute();

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

  // ==========================================================================
  // Query Building Methods
  // ==========================================================================

  /**
   * Adds amount aggregation based on frequency.
   */
  private applyAmountAggregation(query: DynamicQuery, frequency: Frequency): DynamicQuery {
    if (frequency === Frequency.MONTH) {
      return query
        .select(sql<string>`COALESCE(SUM(eli.monthly_amount), 0)`.as('amount'))
        .select(sql<string>`COUNT(*)`.as('count'));
    }

    if (frequency === Frequency.QUARTER) {
      return query
        .select(sql<string>`COALESCE(SUM(eli.quarterly_amount), 0)`.as('amount'))
        .select(sql<string>`COUNT(*)`.as('count'))
        .where('eli.is_quarterly', '=', true);
    }

    // YEARLY
    return query
      .select(sql<string>`COALESCE(SUM(eli.ytd_amount), 0)`.as('amount'))
      .select(sql<string>`COUNT(*)`.as('count'))
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
   * Applies dimension filters (account category, report type, etc.).
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

    // Apply UAT join if needed
    if (requiresUatJoin) {
      query = query.leftJoin('uats as u', 'e.uat_id', 'u.id');

      if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
        query = query.where('u.county_code', 'in', filter.county_codes);
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

    // Economic code exclusions apply only to non-VN accounts (per spec)
    if (
      filter.account_category !== 'vn' &&
      ex.economic_codes !== undefined &&
      ex.economic_codes.length > 0
    ) {
      query = query.where('eli.economic_code', 'not in', ex.economic_codes);
    }

    if (
      filter.account_category !== 'vn' &&
      ex.economic_prefixes !== undefined &&
      ex.economic_prefixes.length > 0
    ) {
      const prefixes = ex.economic_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.economic_code', 'like', `${p}%`));
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
   * Applies per-item amount constraints (WHERE clause).
   */
  private applyItemAmountConstraints(
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
