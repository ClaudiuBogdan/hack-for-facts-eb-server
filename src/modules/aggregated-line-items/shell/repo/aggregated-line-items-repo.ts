/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires any typing */
import { Decimal } from 'decimal.js';
import { sql, type ExpressionBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import {
  extractYear,
  parsePeriodDate,
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
    const frequency = filter.report_period.frequency;

    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Handle empty factor map
      if (factorMap.size === 0) {
        return ok({ items: [], totalCount: 0 });
      }

      // Build VALUES clause for factors CTE
      const factorValues = this.buildFactorValuesCTE(factorMap);

      // Get the appropriate amount column based on frequency
      const amountColumn = this.getAmountColumnName(frequency);

      // Build COALESCE expressions for economic code/name (identical to SELECT and GROUP BY)
      const economicCodeCoalesce = `COALESCE(eli.economic_code, '${UNKNOWN_ECONOMIC_CODE}')`;
      const economicNameCoalesce = `COALESCE(ec.economic_name, '${UNKNOWN_ECONOMIC_NAME}')`;

      // Build normalized amount expression
      const normalizedAmountExpr = `COALESCE(SUM(eli.${amountColumn} * f.multiplier), 0)`;

      // Determine required joins based on filter
      const requiresEntityJoin = needsEntityJoin(filter);
      const requiresUatJoin = needsUatJoin(filter);

      // Build join clauses
      const entityJoinClause = requiresEntityJoin
        ? 'LEFT JOIN entities e ON eli.entity_cui = e.cui'
        : '';
      const uatJoinClause = requiresUatJoin ? 'LEFT JOIN uats u ON e.uat_id = u.id' : '';

      // Build WHERE conditions
      const whereConditions = this.buildNormalizedWhereConditions(
        filter,
        frequency,
        requiresEntityJoin,
        requiresUatJoin
      );

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
          ${sql.raw(economicCodeCoalesce)} AS economic_code,
          ${sql.raw(economicNameCoalesce)} AS economic_name,
          ${sql.raw(normalizedAmountExpr)} AS normalized_amount,
          COUNT(*) AS count,
          COUNT(*) OVER() AS total_count
        FROM executionlineitems eli
        INNER JOIN functionalclassifications fc ON eli.functional_code = fc.functional_code
        LEFT JOIN economicclassifications ec ON eli.economic_code = ec.economic_code
        INNER JOIN factors f ON eli.year::text = f.period_key
        ${sql.raw(entityJoinClause)}
        ${sql.raw(uatJoinClause)}
        ${sql.raw(whereConditions)}
        GROUP BY
          fc.functional_code,
          fc.functional_name,
          ${sql.raw(economicCodeCoalesce)},
          ${sql.raw(economicNameCoalesce)}
        ${sql.raw(havingConditions)}
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
   * Gets the amount column name based on frequency.
   */
  private getAmountColumnName(frequency: Frequency): string {
    if (frequency === Frequency.MONTH) {
      return 'monthly_amount';
    }
    if (frequency === Frequency.QUARTER) {
      return 'quarterly_amount';
    }
    return 'ytd_amount';
  }

  /**
   * Builds WHERE conditions for the normalized aggregation query.
   *
   * Returns a string starting with "WHERE" if there are conditions,
   * or an empty string if no conditions.
   *
   * @param hasEntityJoin - Whether entities table is joined (enables entity_type, is_uat, uat_id filters)
   * @param hasUatJoin - Whether uats table is joined (enables county_code, population filters)
   */
  private buildNormalizedWhereConditions(
    filter: AnalyticsFilter,
    frequency: Frequency,
    hasEntityJoin: boolean,
    hasUatJoin: boolean
  ): string {
    const conditions: string[] = [];

    // Frequency-based filter
    if (frequency === Frequency.QUARTER) {
      conditions.push('eli.is_quarterly = true');
    } else if (frequency === Frequency.YEAR) {
      conditions.push('eli.is_yearly = true');
    }

    // Required filter: account category
    conditions.push(`eli.account_category = '${filter.account_category}'`);

    // Period filters - must match frequency for correct results
    const { selection } = filter.report_period;
    if (selection.interval !== undefined) {
      const start = parsePeriodDate(selection.interval.start);
      const end = parsePeriodDate(selection.interval.end);

      if (frequency === Frequency.MONTH && start?.month !== undefined && end?.month !== undefined) {
        // Filter by (year, month) tuple
        conditions.push(`(eli.year, eli.month) >= (${String(start.year)}, ${String(start.month)})`);
        conditions.push(`(eli.year, eli.month) <= (${String(end.year)}, ${String(end.month)})`);
      } else if (
        frequency === Frequency.QUARTER &&
        start?.quarter !== undefined &&
        end?.quarter !== undefined
      ) {
        // Filter by (year, quarter) tuple
        conditions.push(
          `(eli.year, eli.quarter) >= (${String(start.year)}, ${String(start.quarter)})`
        );
        conditions.push(`(eli.year, eli.quarter) <= (${String(end.year)}, ${String(end.quarter)})`);
      } else {
        // YEAR frequency or fallback: filter by year only
        const startYear = start?.year ?? extractYear(selection.interval.start);
        const endYear = end?.year ?? extractYear(selection.interval.end);
        if (startYear !== null) {
          conditions.push(`eli.year >= ${String(startYear)}`);
        }
        if (endYear !== null) {
          conditions.push(`eli.year <= ${String(endYear)}`);
        }
      }
    }
    if (selection.dates !== undefined && selection.dates.length > 0) {
      if (frequency === Frequency.MONTH) {
        // Parse all dates and filter by (year, month) tuples
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; month: number } => p?.month !== undefined);
        if (validPeriods.length > 0) {
          const tupleConditions = validPeriods
            .map((p) => `(eli.year = ${String(p.year)} AND eli.month = ${String(p.month)})`)
            .join(' OR ');
          conditions.push(`(${tupleConditions})`);
        }
      } else if (frequency === Frequency.QUARTER) {
        // Parse all dates and filter by (year, quarter) tuples
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; quarter: number } => p?.quarter !== undefined);
        if (validPeriods.length > 0) {
          const tupleConditions = validPeriods
            .map((p) => `(eli.year = ${String(p.year)} AND eli.quarter = ${String(p.quarter)})`)
            .join(' OR ');
          conditions.push(`(${tupleConditions})`);
        }
      } else {
        // YEAR frequency: filter by years only
        const years = selection.dates
          .map((d) => extractYear(d))
          .filter((y): y is number => y !== null);
        if (years.length > 0) {
          conditions.push(`eli.year IN (${years.join(', ')})`);
        }
      }
    }

    // Optional dimension filters
    if (filter.report_type !== undefined) {
      conditions.push(`eli.report_type = '${filter.report_type}'`);
    }
    if (filter.main_creditor_cui !== undefined) {
      conditions.push(`eli.main_creditor_cui = '${filter.main_creditor_cui}'`);
    }
    if (filter.report_ids !== undefined && filter.report_ids.length > 0) {
      const ids = filter.report_ids.map((id) => `'${id}'`).join(', ');
      conditions.push(`eli.report_id IN (${ids})`);
    }
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      const cuis = filter.entity_cuis.map((c) => `'${c}'`).join(', ');
      conditions.push(`eli.entity_cui IN (${cuis})`);
    }
    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const numericIds = toNumericIds(filter.funding_source_ids);
      if (numericIds.length > 0) {
        conditions.push(`eli.funding_source_id IN (${numericIds.join(', ')})`);
      }
    }
    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const numericIds = toNumericIds(filter.budget_sector_ids);
      if (numericIds.length > 0) {
        conditions.push(`eli.budget_sector_id IN (${numericIds.join(', ')})`);
      }
    }
    if (filter.expense_types !== undefined && filter.expense_types.length > 0) {
      const types = filter.expense_types.map((t) => `'${t}'`).join(', ');
      conditions.push(`eli.expense_type IN (${types})`);
    }

    // Code filters
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      const codes = filter.functional_codes.map((c) => `'${c}'`).join(', ');
      conditions.push(`eli.functional_code IN (${codes})`);
    }
    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const prefixConditions = filter.functional_prefixes
        .map((p) => `eli.functional_code LIKE '${p}%'`)
        .join(' OR ');
      conditions.push(`(${prefixConditions})`);
    }
    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      const codes = filter.economic_codes.map((c) => `'${c}'`).join(', ');
      conditions.push(`eli.economic_code IN (${codes})`);
    }
    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const prefixConditions = filter.economic_prefixes
        .map((p) => `eli.economic_code LIKE '${p}%'`)
        .join(' OR ');
      conditions.push(`(${prefixConditions})`);
    }
    if (filter.program_codes !== undefined && filter.program_codes.length > 0) {
      const codes = filter.program_codes.map((c) => `'${c}'`).join(', ');
      conditions.push(`eli.program_code IN (${codes})`);
    }

    // Geographic filters (require entity join)
    if (hasEntityJoin) {
      if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
        const types = filter.entity_types.map((t) => `'${t}'`).join(', ');
        conditions.push(`e.entity_type IN (${types})`);
      }
      if (filter.is_uat !== undefined) {
        conditions.push(`e.is_uat = ${String(filter.is_uat)}`);
      }
      if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
        const numericIds = toNumericIds(filter.uat_ids);
        if (numericIds.length > 0) {
          conditions.push(`e.uat_id IN (${numericIds.join(', ')})`);
        }
      }
    }

    // Geographic filters (require UAT join)
    if (hasUatJoin) {
      if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
        const codes = filter.county_codes.map((c) => `'${c}'`).join(', ');
        conditions.push(`u.county_code IN (${codes})`);
      }
      if (filter.min_population !== undefined && filter.min_population !== null) {
        conditions.push(`u.population >= ${String(filter.min_population)}`);
      }
      if (filter.max_population !== undefined && filter.max_population !== null) {
        conditions.push(`u.population <= ${String(filter.max_population)}`);
      }
    }

    // Item amount constraints
    const amountColumn = this.getAmountColumnName(frequency);
    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      conditions.push(`eli.${amountColumn} >= ${String(filter.item_min_amount)}`);
    }
    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      conditions.push(`eli.${amountColumn} <= ${String(filter.item_max_amount)}`);
    }

    // Exclusions
    this.buildExclusionConditions(conditions, filter, hasEntityJoin, hasUatJoin);

    if (conditions.length === 0) {
      return '';
    }

    return `WHERE ${conditions.join(' AND ')}`;
  }

  /**
   * Builds exclusion conditions and adds them to the conditions array.
   */
  private buildExclusionConditions(
    conditions: string[],
    filter: AnalyticsFilter,
    hasEntityJoin: boolean,
    hasUatJoin: boolean
  ): void {
    if (filter.exclude === undefined) {
      return;
    }

    const ex = filter.exclude;

    if (ex.report_ids !== undefined && ex.report_ids.length > 0) {
      const ids = ex.report_ids.map((id) => `'${id}'`).join(', ');
      conditions.push(`eli.report_id NOT IN (${ids})`);
    }

    if (ex.entity_cuis !== undefined && ex.entity_cuis.length > 0) {
      const cuis = ex.entity_cuis.map((c) => `'${c}'`).join(', ');
      conditions.push(`eli.entity_cui NOT IN (${cuis})`);
    }

    if (ex.functional_codes !== undefined && ex.functional_codes.length > 0) {
      const codes = ex.functional_codes.map((c) => `'${c}'`).join(', ');
      conditions.push(`eli.functional_code NOT IN (${codes})`);
    }

    if (ex.functional_prefixes !== undefined && ex.functional_prefixes.length > 0) {
      const prefixConditions = ex.functional_prefixes
        .map((p) => `eli.functional_code NOT LIKE '${p}%'`)
        .join(' AND ');
      conditions.push(`(${prefixConditions})`);
    }

    // Economic code exclusions apply only to non-VN accounts (per spec)
    if (filter.account_category !== 'vn') {
      if (ex.economic_codes !== undefined && ex.economic_codes.length > 0) {
        const codes = ex.economic_codes.map((c) => `'${c}'`).join(', ');
        conditions.push(`eli.economic_code NOT IN (${codes})`);
      }

      if (ex.economic_prefixes !== undefined && ex.economic_prefixes.length > 0) {
        const prefixConditions = ex.economic_prefixes
          .map((p) => `eli.economic_code NOT LIKE '${p}%'`)
          .join(' AND ');
        conditions.push(`(${prefixConditions})`);
      }
    }

    // Geographic exclusions (require entity join)
    if (hasEntityJoin && ex.entity_types !== undefined && ex.entity_types.length > 0) {
      const types = ex.entity_types.map((t) => `'${t}'`).join(', ');
      conditions.push(`(e.entity_type IS NULL OR e.entity_type NOT IN (${types}))`);
    }

    if (hasEntityJoin && ex.uat_ids !== undefined && ex.uat_ids.length > 0) {
      const numericIds = toNumericIds(ex.uat_ids);
      if (numericIds.length > 0) {
        conditions.push(`(e.uat_id IS NULL OR e.uat_id NOT IN (${numericIds.join(', ')}))`);
      }
    }

    // Geographic exclusions (require UAT join)
    if (hasUatJoin && ex.county_codes !== undefined && ex.county_codes.length > 0) {
      const codes = ex.county_codes.map((c) => `'${c}'`).join(', ');
      conditions.push(`(u.county_code IS NULL OR u.county_code NOT IN (${codes}))`);
    }
  }

  /**
   * Builds HAVING conditions for aggregate filters.
   *
   * Returns a string starting with "HAVING" if there are conditions,
   * or an empty string if no conditions.
   */
  private buildHavingConditions(aggregateFilters?: AggregateFilters): string {
    if (aggregateFilters === undefined) {
      return '';
    }

    const conditions: string[] = [];

    if (aggregateFilters.minAmount !== undefined) {
      conditions.push(`normalized_amount >= ${aggregateFilters.minAmount.toString()}`);
    }
    if (aggregateFilters.maxAmount !== undefined) {
      conditions.push(`normalized_amount <= ${aggregateFilters.maxAmount.toString()}`);
    }

    if (conditions.length === 0) {
      return '';
    }

    return `HAVING ${conditions.join(' AND ')}`;
  }

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
   *
   * IMPORTANT: Filtering must match the frequency:
   * - YEAR: Filter by year only
   * - MONTH: Filter by (year, month) tuple
   * - QUARTER: Filter by (year, quarter) tuple
   *
   * This ensures correct results when querying specific months or quarters.
   */
  private applyPeriodFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    const { selection, frequency } = filter.report_period;

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
