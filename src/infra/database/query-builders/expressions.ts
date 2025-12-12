/**
 * SQL Expressions - Safe SQL Fragment Construction
 *
 * Provides type-safe builders for common SQL expressions:
 * - JOIN clauses
 * - ORDER BY clauses
 * - GROUP BY clauses
 * - COALESCE expressions
 * - Aggregate expressions
 *
 * SECURITY: All identifiers are validated against known schema values.
 * We use Kysely's sql template tag and helpers (sql.ref, sql.table) to ensure safety.
 */

import { sql, type RawBuilder } from 'kysely';

import { TableNames, type TableName, type TableAlias } from './identifiers.js';

// ============================================================================
// Join Expressions
// ============================================================================

/**
 * Join type options.
 */
export type JoinType = 'INNER' | 'LEFT' | 'RIGHT';

/**
 * Creates a JOIN clause.
 *
 * @param joinType - Type of join (INNER, LEFT, RIGHT)
 * @param table - Table name to join
 * @param alias - Alias for the joined table
 * @param leftCol - Left side of the ON condition (qualified)
 * @param rightCol - Right side of the ON condition (qualified)
 * @returns RawBuilder for the JOIN clause
 *
 * @example
 * ```typescript
 * joinClause('LEFT', 'entities', 'e', 'eli.entity_cui', 'e.cui')
 * // Produces: LEFT JOIN entities e ON eli.entity_cui = e.cui
 * ```
 */
export function joinClause(
  joinType: JoinType,
  table: TableName,
  alias: TableAlias,
  leftCol: string,
  rightCol: string
): RawBuilder<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive check
  const tableName = TableNames[table] ?? table;

  if (!['INNER', 'LEFT', 'RIGHT'].includes(joinType)) {
    throw new Error(`Invalid join type: ${joinType}`);
  }

  // SECURITY: identifiers are parameterized/quoted safely
  return sql`${sql.raw(joinType)} JOIN ${sql.table(tableName)} ${sql.raw(alias)} ON ${sql.ref(leftCol)} = ${sql.ref(rightCol)}`;
}

/**
 * Creates an empty join (no-op).
 * Useful for conditional join building.
 */
export function noJoin(): RawBuilder<unknown> {
  return sql``;
}

// ============================================================================
// Pre-defined Common Joins
// ============================================================================

/**
 * Common JOIN clauses used across repositories.
 * These are pre-built for convenience and consistency.
 */
export const CommonJoins = {
  /**
   * LEFT JOIN entities e ON eli.entity_cui = e.cui
   */
  entityOnLineItem: (): RawBuilder<unknown> =>
    sql.raw('LEFT JOIN entities e ON eli.entity_cui = e.cui'),

  /**
   * INNER JOIN entities e ON eli.entity_cui = e.cui
   */
  entityOnLineItemInner: (): RawBuilder<unknown> =>
    sql.raw('INNER JOIN entities e ON eli.entity_cui = e.cui'),

  /**
   * LEFT JOIN uats u ON e.uat_id = u.id
   */
  uatOnEntity: (): RawBuilder<unknown> => sql.raw('LEFT JOIN uats u ON e.uat_id = u.id'),

  /**
   * INNER JOIN functionalclassifications fc ON eli.functional_code = fc.functional_code
   */
  functionalClassification: (): RawBuilder<unknown> =>
    sql.raw('INNER JOIN functionalclassifications fc ON eli.functional_code = fc.functional_code'),

  /**
   * LEFT JOIN economicclassifications ec ON eli.economic_code = ec.economic_code
   */
  economicClassification: (): RawBuilder<unknown> =>
    sql.raw('LEFT JOIN economicclassifications ec ON eli.economic_code = ec.economic_code'),

  /**
   * INNER JOIN factors f ON eli.year::text = f.period_key
   * Used with normalization factor CTEs.
   */
  factorsOnYear: (): RawBuilder<unknown> =>
    sql.raw('INNER JOIN factors f ON eli.year::text = f.period_key'),

  /**
   * LEFT JOIN county_populations cp ON u.county_code = cp.county_code
   * Used with county population CTEs.
   */
  countyPopulations: (): RawBuilder<unknown> =>
    sql.raw('LEFT JOIN county_populations cp ON u.county_code = cp.county_code'),

  /**
   * INNER JOIN entities e ON fa.entity_cui = e.cui
   * Used with filtered_aggregates CTE.
   */
  entityOnFilteredAggregates: (): RawBuilder<unknown> =>
    sql.raw('INNER JOIN entities e ON fa.entity_cui = e.cui'),
} as const;

// ============================================================================
// Order By Expressions
// ============================================================================

/**
 * Sort direction.
 */
export type SortDirection = 'ASC' | 'DESC';

/**
 * NULL handling in ORDER BY.
 */
export type NullsPosition = 'NULLS FIRST' | 'NULLS LAST';

/**
 * Creates an ORDER BY clause.
 *
 * @param terms - Array of [column, direction, nulls] tuples
 * @returns RawBuilder for the ORDER BY clause
 *
 * @example
 * ```typescript
 * orderByClause([
 *   ['total_amount', 'DESC', 'NULLS LAST'],
 *   ['entity_name', 'ASC', 'NULLS LAST'],
 * ])
 * // Produces: ORDER BY total_amount DESC NULLS LAST, entity_name ASC NULLS LAST
 * ```
 */
export function orderByClause(
  terms: [string, SortDirection, NullsPosition?][]
): RawBuilder<unknown> {
  if (terms.length === 0) {
    return sql``;
  }

  const fragments = terms.map(([col, dir, nulls]) => {
    if (!['ASC', 'DESC'].includes(dir)) {
      throw new Error(`Invalid sort direction: ${dir}`);
    }
    const nullsStr = nulls ?? 'NULLS LAST';
    if (!['NULLS FIRST', 'NULLS LAST'].includes(nullsStr)) {
      throw new Error(`Invalid nulls position: ${nullsStr}`);
    }

    return sql`${sql.ref(col)} ${sql.raw(dir)} ${sql.raw(nullsStr)}`;
  });

  return sql`ORDER BY ${sql.join(fragments, sql`, `)}`;
}

/**
 * Common ORDER BY clauses for analytics queries.
 */
export const CommonOrderBy = {
  /**
   * ORDER BY eli.year ASC
   */
  yearAsc: (): RawBuilder<unknown> => sql`eli.year ASC`,

  /**
   * ORDER BY eli.year ASC, eli.month ASC
   */
  yearMonthAsc: (): RawBuilder<unknown> => sql`eli.year ASC, eli.month ASC`,

  /**
   * ORDER BY eli.year ASC, eli.quarter ASC
   */
  yearQuarterAsc: (): RawBuilder<unknown> => sql`eli.year ASC, eli.quarter ASC`,

  /**
   * ORDER BY normalized_amount DESC NULLS LAST
   */
  normalizedAmountDesc: (): RawBuilder<unknown> => sql`normalized_amount DESC NULLS LAST`,

  /**
   * ORDER BY total_amount DESC NULLS LAST
   */
  totalAmountDesc: (): RawBuilder<unknown> => sql`total_amount DESC NULLS LAST`,
} as const;

// ============================================================================
// Group By Expressions
// ============================================================================

/**
 * Creates a GROUP BY clause.
 *
 * @param columns - Array of column references (qualified or unqualified)
 * @returns RawBuilder for the GROUP BY clause
 *
 * @example
 * ```typescript
 * groupByClause(['eli.year', 'eli.month'])
 * // Produces: GROUP BY eli.year, eli.month
 * ```
 */
export function groupByClause(columns: string[]): RawBuilder<unknown> {
  if (columns.length === 0) {
    return sql``;
  }

  return sql`GROUP BY ${sql.join(
    columns.map((c) => sql.ref(c)),
    sql`, `
  )}`;
}

/**
 * Common GROUP BY clauses for analytics queries.
 */
export const CommonGroupBy = {
  /**
   * GROUP BY eli.year
   */
  year: (): RawBuilder<unknown> => sql`eli.year`,

  /**
   * GROUP BY eli.year, eli.month
   */
  yearMonth: (): RawBuilder<unknown> => sql`eli.year, eli.month`,

  /**
   * GROUP BY eli.year, eli.quarter
   */
  yearQuarter: (): RawBuilder<unknown> => sql`eli.year, eli.quarter`,

  /**
   * GROUP BY eli.entity_cui
   */
  entityCui: (): RawBuilder<unknown> => sql`eli.entity_cui`,
} as const;

// ============================================================================
// Aggregate Expressions
// ============================================================================

/**
 * Creates a COALESCE expression with a default value.
 *
 * @param expr - Expression (column reference) to coalesce
 * @param defaultValue - Default value if expr is NULL
 * @returns RawBuilder for the COALESCE expression
 */
export function coalesce(expr: string, defaultValue: string | number): RawBuilder<unknown> {
  return sql`COALESCE(${sql.ref(expr)}, ${defaultValue})`;
}

/**
 * Creates a SUM expression.
 *
 * @param column - Column to sum (qualified)
 * @returns RawBuilder for the SUM expression
 */
export function sumExpr(column: string): RawBuilder<unknown> {
  return sql`SUM(${sql.ref(column)})`;
}

/**
 * Creates a COALESCE(SUM(...), 0) expression.
 *
 * @param column - Column to sum (qualified)
 * @returns RawBuilder for the expression
 */
export function coalesceSumExpr(column: string): RawBuilder<unknown> {
  return sql`COALESCE(SUM(${sql.ref(column)}), 0)`;
}

/**
 * Creates a COUNT(*) expression.
 */
export function countExpr(): RawBuilder<unknown> {
  return sql.raw('COUNT(*)');
}

/**
 * Creates a COUNT(*) OVER() window expression for total count.
 */
export function countOverExpr(): RawBuilder<unknown> {
  return sql.raw('COUNT(*) OVER()');
}

// ============================================================================
// COALESCE Patterns for Unknown Classifications
// ============================================================================

/**
 * Unknown economic code placeholder.
 * Note: Must match the value in aggregated-line-items/core/types.ts
 */
export const UNKNOWN_ECONOMIC_CODE = '00.00.00';

/**
 * Unknown economic name placeholder.
 * Note: Must match the value in aggregated-line-items/core/types.ts
 */
export const UNKNOWN_ECONOMIC_NAME = 'Unknown economic classification';

/**
 * Creates a COALESCE expression for economic code with unknown fallback.
 */
export function coalesceEconomicCode(): RawBuilder<unknown> {
  return sql.raw(`COALESCE(eli.economic_code, '${UNKNOWN_ECONOMIC_CODE}')`);
}

/**
 * Creates a COALESCE expression for economic name with unknown fallback.
 */
export function coalesceEconomicName(): RawBuilder<unknown> {
  return sql.raw(`COALESCE(ec.economic_name, '${UNKNOWN_ECONOMIC_NAME}')`);
}

// ============================================================================
// Entity Analytics Expressions
// ============================================================================

/**
 * Creates an expression for normalized amount sum: COALESCE(SUM(col * f.multiplier), 0)
 *
 * @param amountCol - RawBuilder for the amount column (e.g. from amountColumnRef)
 */
export function normalizedAmountExpr(amountCol: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`COALESCE(SUM(${amountCol} * f.multiplier), 0)`;
}

/**
 * Creates a CASE expression for entity population based on type.
 *
 * Logic:
 * - UAT (is_uat=true) -> u.population
 * - County Council -> cp.county_population
 * - Other -> NULL
 *
 * @param entityAlias - Alias for entities table (default 'e')
 * @param uatAlias - Alias for uats table (default 'u')
 * @param countyPopAlias - Alias for county_populations CTE (default 'cp')
 */
export function populationCaseExpr(
  entityAlias: 'e' = 'e',
  uatAlias: 'u' = 'u',
  countyPopAlias: 'cp' = 'cp'
): RawBuilder<unknown> {
  // We use sql.raw for aliases as they are trusted internal constants
  // This avoids parameterizing table names which is invalid SQL
  const e = sql.raw(entityAlias);
  const u = sql.raw(uatAlias);
  const cp = sql.raw(countyPopAlias);

  return sql`
    CASE
      WHEN ${e}.is_uat = true THEN ${u}.population
      WHEN ${e}.entity_type = 'admin_county_council' THEN ${cp}.county_population
      ELSE NULL
    END
  `;
}

/**
 * Creates an expression for per-capita amount: normalized_amount / population
 * Handles division by zero/null using safe division pattern.
 *
 * @param normalizedAmountCol - Reference to normalized amount column (default 'fa.normalized_amount')
 * @param populationExpr - The population expression (from populationCaseExpr)
 */
export function perCapitaExpr(
  normalizedAmountCol: RawBuilder<unknown> = sql.raw('fa.normalized_amount'),
  populationExpr: RawBuilder<unknown>
): RawBuilder<unknown> {
  return sql`
    COALESCE(
      ${normalizedAmountCol} / NULLIF(${populationExpr}, 0),
      0
    )
  `;
}

// ============================================================================
// Sort Field Mapping for Entity Analytics
// ============================================================================

/**
 * Valid sort fields for entity analytics queries.
 */
export type EntityAnalyticsSortField =
  | 'AMOUNT'
  | 'TOTAL_AMOUNT'
  | 'PER_CAPITA_AMOUNT'
  | 'ENTITY_NAME'
  | 'ENTITY_TYPE'
  | 'POPULATION'
  | 'COUNTY_NAME'
  | 'COUNTY_CODE';

/**
 * Maps entity analytics sort field to SQL column expression.
 */
const ENTITY_ANALYTICS_SORT_MAP: Record<EntityAnalyticsSortField, string> = {
  AMOUNT: 'total_amount',
  TOTAL_AMOUNT: 'total_amount',
  PER_CAPITA_AMOUNT: 'per_capita_amount',
  ENTITY_NAME: 'entity_name',
  ENTITY_TYPE: 'entity_type',
  POPULATION: 'population',
  COUNTY_NAME: 'county_name',
  COUNTY_CODE: 'county_code',
};

/**
 * Gets the SQL column for an entity analytics sort field.
 */
export function getEntityAnalyticsSortColumn(field: EntityAnalyticsSortField): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive check
  const col = ENTITY_ANALYTICS_SORT_MAP[field] ?? 'total_amount';
  return col;
}

/**
 * Creates an ORDER BY clause for entity analytics.
 */
export function entityAnalyticsOrderBy(
  field: EntityAnalyticsSortField,
  direction: SortDirection
): RawBuilder<unknown> {
  const col = getEntityAnalyticsSortColumn(field);

  if (!['ASC', 'DESC'].includes(direction)) {
    throw new Error(`Invalid sort direction: ${direction}`);
  }

  return sql`ORDER BY ${sql.ref(col)} ${sql.raw(direction)} NULLS LAST`;
}
