import { Decimal } from 'decimal.js';
import { sql, type RawBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
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
  type SqlCondition,
} from '@/infra/database/query-filters/index.js';

import {
  createDatabaseError,
  createTimeoutError,
  type EntityAnalyticsError,
} from '../../core/errors.js';
import {
  type EntityAnalyticsResult,
  type EntityAnalyticsRow,
  type PeriodFactorMap,
  type AggregateFilters,
  type PaginationParams,
  type EntityAnalyticsSort,
  type EntityAnalyticsSortField,
} from '../../core/types.js';

import type { EntityAnalyticsRepository } from '../../core/ports.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Constants
// ============================================================================

/** Query timeout in milliseconds (30 seconds) */
const QUERY_TIMEOUT_MS = 30_000;

/**
 * Bucharest's special SIRUTA code for municipality-level population.
 * Bucharest (county_code = 'B') uses this code instead of county-level.
 */
const BUCHAREST_SIRUTA_CODE = '179132';

// ============================================================================
// Types
// ============================================================================

/**
 * Raw row returned from the entity analytics query.
 */
interface RawEntityAnalyticsRow {
  entity_cui: string;
  entity_name: string;
  entity_type: string | null;
  uat_id: number | null;
  county_code: string | null;
  county_name: string | null;
  population: string | null; // NUMERIC/INT comes as string
  total_amount: string; // NUMERIC comes as string
  per_capita_amount: string; // NUMERIC comes as string
  total_count: string; // Window function result
}

/**
 * Maps sort field enum values to SQL column expressions.
 */
const SORT_FIELD_MAP: Record<EntityAnalyticsSortField, string> = {
  AMOUNT: 'total_amount',
  TOTAL_AMOUNT: 'total_amount',
  PER_CAPITA_AMOUNT: 'per_capita_amount',
  ENTITY_NAME: 'entity_name',
  ENTITY_TYPE: 'entity_type',
  POPULATION: 'population',
  COUNTY_NAME: 'county_name',
  COUNTY_CODE: 'county_code',
};

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Kysely-based implementation of EntityAnalyticsRepository.
 *
 * This repository aggregates ExecutionLineItems by entity_cui to provide
 * entity-level budget analytics with per-entity population handling.
 *
 * Key Differences from AggregatedLineItemsRepository:
 * 1. Groups by entity_cui (not classification codes)
 * 2. Population is entity-specific (varies by entity type), not filter-based
 * 3. Supports 8 sortable fields with proper NULL handling
 *
 * Population Handling:
 * - UAT entities (is_uat = true): UAT's own population
 * - County councils (entity_type = 'admin_county_council'): County aggregate population
 * - Other entities: NULL population, per_capita_amount = 0
 */
export class KyselyEntityAnalyticsRepo implements EntityAnalyticsRepository {
  constructor(private readonly db: BudgetDbClient) {}

  /**
   * Fetches entity analytics with SQL-level normalization, sorting, and pagination.
   *
   * SQL Structure:
   * ```sql
   * WITH
   *   county_populations AS (...),  -- Pre-compute county-level populations
   *   factors(period_key, multiplier) AS (VALUES ...),  -- Normalization multipliers
   *   filtered_aggregates AS (
   *     SELECT entity_cui, SUM(<amount_col> * f.multiplier) AS normalized_amount
   *     FROM executionlineitems eli
   *     INNER JOIN factors f ON eli.year::text = f.period_key
   *     [joins and filters]
   *     GROUP BY entity_cui
   *     HAVING [aggregate filters]
   *   )
   * SELECT
   *   e.cui, e.name, e.entity_type, e.uat_id,
   *   u.county_code, COALESCE(u.county_name, c.county_name),
   *   CASE WHEN e.is_uat THEN u.population
   *        WHEN e.entity_type = 'admin_county_council' THEN cp.county_population
   *        ELSE NULL END AS population,
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
   */
  async getEntityAnalytics(
    filter: AnalyticsFilter,
    factorMap: PeriodFactorMap,
    pagination: PaginationParams,
    sort: EntityAnalyticsSort,
    aggregateFilters?: AggregateFilters
  ): Promise<Result<EntityAnalyticsResult, EntityAnalyticsError>> {
    const frequency = filter.report_period.type;

    try {
      // Set statement timeout
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // Handle empty factor map
      if (factorMap.size === 0) {
        return ok({ items: [], totalCount: 0 });
      }

      // Build the complete query
      const queryText = this.buildEntityAnalyticsQuery(
        filter,
        factorMap,
        frequency,
        pagination,
        sort,
        aggregateFilters
      );

      // Execute query
      const result = await queryText.execute(this.db);
      const rows = result.rows as RawEntityAnalyticsRow[];

      // Transform to domain types
      const items = this.transformRows(rows);
      const firstRow = rows[0];
      const totalCount = firstRow !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

      return ok({ items, totalCount });
    } catch (error) {
      return this.handleQueryError(error);
    }
  }

  // ==========================================================================
  // Query Building
  // ==========================================================================

  /**
   * Builds the complete entity analytics query with all CTEs.
   */
  private buildEntityAnalyticsQuery(
    filter: AnalyticsFilter,
    factorMap: PeriodFactorMap,
    frequency: Frequency,
    pagination: PaginationParams,
    sort: EntityAnalyticsSort,
    aggregateFilters?: AggregateFilters
  ): ReturnType<typeof sql> {
    // Build factor VALUES clause
    const factorValues = this.buildFactorValuesCTE(factorMap);

    // Get the appropriate amount column based on frequency
    const amountColumn = this.getAmountColumnName(frequency);

    // Determine if we need entity/UAT joins for geographic filters
    const requiresEntityJoin = needsEntityJoin(filter);
    const requiresUatJoin = needsUatJoin(filter);

    // Build join clauses for filtered_aggregates CTE (static SQL from CommonJoins)
    const entityJoinClause = requiresEntityJoin ? CommonJoins.entityOnLineItemInner() : sql``;
    const uatJoinClause = requiresUatJoin ? CommonJoins.uatOnEntity() : sql``;

    // Build WHERE conditions using composable filter pipeline (parameterized)
    const conditions = this.buildAllConditions(
      filter,
      frequency,
      requiresEntityJoin,
      requiresUatJoin
    );
    const whereCondition = andConditions(conditions);

    // Build HAVING conditions
    const havingConditions = this.buildHavingConditions(aggregateFilters);

    // Build ORDER BY clause
    const orderByClause = this.buildOrderByClause(sort);

    // Population expression: varies by entity type
    const populationExpr = `
      CASE
        WHEN e.is_uat = true THEN u.population
        WHEN e.entity_type = 'admin_county_council' THEN cp.county_population
        ELSE NULL
      END
    `;

    // Per-capita expression: total_amount / population (with safe division)
    const perCapitaExpr = `
      COALESCE(
        fa.normalized_amount / NULLIF(
          CASE
            WHEN e.is_uat = true THEN u.population
            WHEN e.entity_type = 'admin_county_council' THEN cp.county_population
            ELSE NULL
          END, 0
        ), 0
      )
    `;

    // Build safe raw expressions for static SQL fragments
    // NOTE: These sql.raw() usages are for static SQL expressions that are
    // compile-time constants (not derived from user input).
    // eslint-disable-next-line no-restricted-syntax -- Safe: amountColumn from getAmountColumnName()
    const sumExpr = sql.raw(`COALESCE(SUM(eli.${amountColumn} * f.multiplier), 0)`);
    // eslint-disable-next-line no-restricted-syntax -- Safe: static CASE expression
    const populationExprRaw = sql.raw(populationExpr);
    // eslint-disable-next-line no-restricted-syntax -- Safe: static CASE expression
    const perCapitaExprRaw = sql.raw(perCapitaExpr);
    // eslint-disable-next-line no-restricted-syntax -- Safe: orderByClause from SORT_FIELD_MAP
    const orderByRaw = sql.raw(orderByClause);

    // Build the full query with CTEs
    return sql`
      WITH
      -- Pre-compute county populations for county councils
      county_populations AS (
        SELECT
          county_code,
          MAX(CASE
            WHEN county_code = 'B' AND siruta_code = ${BUCHAREST_SIRUTA_CODE} THEN population
            WHEN siruta_code = county_code THEN population
            ELSE 0
          END) AS county_population
        FROM uats
        GROUP BY county_code
      ),
      -- Factor values for normalization
      factors(period_key, multiplier) AS (
        VALUES ${factorValues}
      ),
      -- Filtered aggregates by entity
      filtered_aggregates AS (
        SELECT
          eli.entity_cui,
          ${sumExpr} AS normalized_amount
        FROM executionlineitems eli
        INNER JOIN factors f ON eli.year::text = f.period_key
        ${entityJoinClause}
        ${uatJoinClause}
        WHERE ${whereCondition}
        GROUP BY eli.entity_cui
        ${havingConditions ?? sql``}
      )
      SELECT
        e.cui AS entity_cui,
        e.name AS entity_name,
        e.entity_type,
        e.uat_id,
        u.county_code,
        u.county_name,
        ${populationExprRaw} AS population,
        fa.normalized_amount AS total_amount,
        ${perCapitaExprRaw} AS per_capita_amount,
        COUNT(*) OVER() AS total_count
      FROM filtered_aggregates fa
      INNER JOIN entities e ON fa.entity_cui = e.cui
      LEFT JOIN uats u ON e.uat_id = u.id
      LEFT JOIN county_populations cp ON u.county_code = cp.county_code
      ${orderByRaw}
      LIMIT ${pagination.limit} OFFSET ${pagination.offset}
    `;
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
   * Builds all WHERE conditions using the composable filter pipeline.
   * Returns parameterized SqlCondition RawBuilders for SQL injection prevention.
   */
  private buildAllConditions(
    filter: AnalyticsFilter,
    frequency: Frequency,
    hasEntityJoin: boolean,
    hasUatJoin: boolean
  ): SqlCondition[] {
    const ctx = createFilterContext({
      hasEntityJoin,
      hasUatJoin,
    });

    const conditions: SqlCondition[] = [];

    // Period conditions (date range, discrete dates)
    conditions.push(...buildPeriodConditions(filter.report_period.selection, frequency, ctx));

    // Dimension conditions (account_category, report_type, entity_cuis, etc.)
    conditions.push(...buildDimensionConditions(filter, ctx));

    // Code conditions (functional, economic, program codes)
    conditions.push(...buildCodeConditions(filter, ctx));

    // Entity conditions (if joined)
    if (hasEntityJoin) {
      conditions.push(...buildEntityConditions(filter, ctx));
    }

    // UAT conditions (if joined)
    if (hasUatJoin) {
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
   * Builds HAVING conditions for aggregate filters.
   *
   * Returns a RawBuilder for the HAVING clause, or undefined if no conditions.
   * SECURITY: Uses parameterized queries for aggregate filter values.
   */
  private buildHavingConditions(
    aggregateFilters?: AggregateFilters
  ): RawBuilder<unknown> | undefined {
    if (aggregateFilters === undefined) {
      return undefined;
    }

    const conditions: RawBuilder<unknown>[] = [];

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

  /**
   * Builds ORDER BY clause with proper NULL handling.
   *
   * - NULLS LAST for ASC (NULLs at the end)
   * - NULLS FIRST for DESC (NULLs at the end, reversed)
   */
  private buildOrderByClause(sort: EntityAnalyticsSort): string {
    const sortColumn = SORT_FIELD_MAP[sort.by];
    const direction = sort.order;

    // For numeric columns, NULLS should go to the end
    // ASC: NULLS LAST (smallest first, nulls last)
    // DESC: NULLS LAST (largest first, nulls last)
    const nullsHandling = 'NULLS LAST';

    return `ORDER BY ${sortColumn} ${direction} ${nullsHandling}`;
  }

  // ==========================================================================
  // Result Transformation
  // ==========================================================================

  /**
   * Transforms raw database rows to domain types.
   */
  private transformRows(rows: RawEntityAnalyticsRow[]): EntityAnalyticsRow[] {
    return rows.map((row) => ({
      entity_cui: row.entity_cui,
      entity_name: row.entity_name,
      entity_type: row.entity_type,
      uat_id: row.uat_id,
      county_code: row.county_code,
      county_name: row.county_name,
      population: row.population !== null ? Number.parseInt(row.population, 10) : null,
      total_amount: new Decimal(row.total_amount),
      per_capita_amount: new Decimal(row.per_capita_amount),
    }));
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  /**
   * Handles query errors and returns appropriate error types.
   */
  private handleQueryError(error: unknown): Result<EntityAnalyticsResult, EntityAnalyticsError> {
    const message = error instanceof Error ? error.message : 'Unknown database error';

    // Check for timeout error
    const isTimeout =
      message.includes('statement timeout') ||
      message.includes('57014') ||
      message.includes('canceling statement due to statement timeout');

    if (isTimeout) {
      return err(createTimeoutError('Entity analytics query timed out', error));
    }

    return err(createDatabaseError('Failed to fetch entity analytics', error));
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an EntityAnalyticsRepository instance.
 */
export const makeEntityAnalyticsRepo = (db: BudgetDbClient): EntityAnalyticsRepository => {
  return new KyselyEntityAnalyticsRepo(db);
};
