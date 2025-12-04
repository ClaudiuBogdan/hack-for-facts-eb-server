import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
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

    // Build join clauses for filtered_aggregates CTE
    const entityJoinClause = requiresEntityJoin
      ? 'INNER JOIN entities e ON eli.entity_cui = e.cui'
      : '';
    const uatJoinClause = requiresUatJoin ? 'LEFT JOIN uats u ON e.uat_id = u.id' : '';

    // Build WHERE conditions for filtered_aggregates CTE
    const whereConditions = this.buildWhereConditions(
      filter,
      frequency,
      requiresEntityJoin,
      requiresUatJoin
    );

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
          COALESCE(SUM(eli.${sql.raw(amountColumn)} * f.multiplier), 0) AS normalized_amount
        FROM executionlineitems eli
        INNER JOIN factors f ON eli.year::text = f.period_key
        ${sql.raw(entityJoinClause)}
        ${sql.raw(uatJoinClause)}
        ${sql.raw(whereConditions)}
        GROUP BY eli.entity_cui
        ${sql.raw(havingConditions)}
      )
      SELECT
        e.cui AS entity_cui,
        e.name AS entity_name,
        e.entity_type,
        e.uat_id,
        u.county_code,
        u.county_name,
        ${sql.raw(populationExpr)} AS population,
        fa.normalized_amount AS total_amount,
        ${sql.raw(perCapitaExpr)} AS per_capita_amount,
        COUNT(*) OVER() AS total_count
      FROM filtered_aggregates fa
      INNER JOIN entities e ON fa.entity_cui = e.cui
      LEFT JOIN uats u ON e.uat_id = u.id
      LEFT JOIN county_populations cp ON u.county_code = cp.county_code
      ${sql.raw(orderByClause)}
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
   * Builds WHERE conditions for the filtered_aggregates CTE.
   *
   * Returns a string starting with "WHERE" if there are conditions,
   * or an empty string if no conditions.
   *
   * @param filter - Analytics filter with all filter criteria
   * @param frequency - Time frequency for amount column selection
   * @param hasEntityJoin - Whether entities table is joined (for entity_type, is_uat, uat_ids filters)
   * @param hasUatJoin - Whether uats table is joined (for county_codes, population filters)
   */
  private buildWhereConditions(
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

    // Period filters
    const { selection } = filter.report_period;
    if (selection.interval !== undefined) {
      const startYear = extractYear(selection.interval.start);
      const endYear = extractYear(selection.interval.end);
      if (startYear !== null) {
        conditions.push(`eli.year >= ${String(startYear)}`);
      }
      if (endYear !== null) {
        conditions.push(`eli.year <= ${String(endYear)}`);
      }
    }
    if (selection.dates !== undefined && selection.dates.length > 0) {
      const years = selection.dates
        .map((d) => extractYear(d))
        .filter((y): y is number => y !== null);
      if (years.length > 0) {
        conditions.push(`eli.year IN (${years.join(', ')})`);
      }
    }

    // Optional dimension filters
    if (filter.report_type !== undefined) {
      conditions.push(`eli.report_type = '${filter.report_type}'`);
    }
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      const cuis = filter.entity_cuis.map((c) => `'${c}'`).join(', ');
      conditions.push(`eli.entity_cui IN (${cuis})`);
    }
    if (filter.main_creditor_cui !== undefined) {
      conditions.push(`eli.main_creditor_cui = '${filter.main_creditor_cui}'`);
    }
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
      // Population constraints
      if (filter.min_population !== undefined && filter.min_population !== null) {
        conditions.push(`u.population >= ${String(filter.min_population)}`);
      }
      if (filter.max_population !== undefined && filter.max_population !== null) {
        conditions.push(`u.population <= ${String(filter.max_population)}`);
      }
    }

    // Item amount constraints
    const amountColumn = this.getAmountColumnName(filter.report_period.frequency);
    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      conditions.push(`eli.${amountColumn} >= ${String(filter.item_min_amount)}`);
    }
    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      conditions.push(`eli.${amountColumn} <= ${String(filter.item_max_amount)}`);
    }

    // Exclusion filters
    if (filter.exclude !== undefined) {
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
          .map((p) => `eli.functional_code LIKE '${p}%'`)
          .join(' OR ');
        conditions.push(`NOT (${prefixConditions})`);
      }
      // Economic code exclusions apply only to non-VN accounts (per spec)
      if (
        filter.account_category !== 'vn' &&
        ex.economic_codes !== undefined &&
        ex.economic_codes.length > 0
      ) {
        const codes = ex.economic_codes.map((c) => `'${c}'`).join(', ');
        conditions.push(`eli.economic_code NOT IN (${codes})`);
      }
      if (
        filter.account_category !== 'vn' &&
        ex.economic_prefixes !== undefined &&
        ex.economic_prefixes.length > 0
      ) {
        const prefixConditions = ex.economic_prefixes
          .map((p) => `eli.economic_code LIKE '${p}%'`)
          .join(' OR ');
        conditions.push(`NOT (${prefixConditions})`);
      }

      // Geographic exclusions (require entity join)
      if (hasEntityJoin) {
        if (ex.entity_types !== undefined && ex.entity_types.length > 0) {
          const types = ex.entity_types.map((t) => `'${t}'`).join(', ');
          conditions.push(`(e.entity_type IS NULL OR e.entity_type NOT IN (${types}))`);
        }
        if (ex.uat_ids !== undefined && ex.uat_ids.length > 0) {
          const numericIds = toNumericIds(ex.uat_ids);
          if (numericIds.length > 0) {
            conditions.push(`(e.uat_id IS NULL OR e.uat_id NOT IN (${numericIds.join(', ')}))`);
          }
        }
      }

      // Geographic exclusions (require UAT join)
      if (hasUatJoin) {
        if (ex.county_codes !== undefined && ex.county_codes.length > 0) {
          const codes = ex.county_codes.map((c) => `'${c}'`).join(', ');
          conditions.push(`(u.county_code IS NULL OR u.county_code NOT IN (${codes}))`);
        }
      }
    }

    if (conditions.length === 0) {
      return '';
    }

    return `WHERE ${conditions.join(' AND ')}`;
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
