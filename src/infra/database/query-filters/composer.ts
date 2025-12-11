/**
 * Query Filter Composer
 *
 * Utilities for composing parameterized SQL conditions using Kysely's RawBuilder.
 *
 * SECURITY: All user values are automatically parameterized via sql`` template tag.
 * The database driver handles escaping - SQL injection is prevented by design.
 */

import { sql, type RawBuilder } from 'kysely';

import type { FilterContext, SqlCondition, ConditionBuilder } from './types.js';

// ============================================================================
// Column Reference Helper
// ============================================================================

/**
 * Creates a column reference for use in SQL conditions.
 *
 * SECURITY: Only use with trusted, internal alias values (from FilterContext).
 * The alias comes from internal code, not user input, so sql.raw is safe here.
 *
 * @param alias - Table alias (trusted internal value)
 * @param column - Column name (trusted internal value)
 * @returns RawBuilder for the column reference
 */
export function col(alias: string, column: string): RawBuilder<unknown> {
  return sql.raw(`${alias}.${column}`);
}

// ============================================================================
// Condition Composition
// ============================================================================

/**
 * Composes multiple condition builders into a single WHERE clause RawBuilder.
 *
 * @param ctx - Filter context with table aliases and join state
 * @param builders - Array of condition builder functions
 * @returns RawBuilder for complete WHERE clause, or undefined if no conditions
 *
 * @example
 * ```ts
 * const whereClause = composeConditions(
 *   ctx,
 *   (c) => buildPeriodConditions(filter.report_period, c),
 *   (c) => buildDimensionConditions(filter, c),
 * );
 * // Use in query: sql`SELECT ... FROM t ${whereClause}`
 * ```
 */
export function composeConditions(
  ctx: FilterContext,
  ...builders: ConditionBuilder[]
): RawBuilder<unknown> | undefined {
  const allConditions = builders.flatMap((builder) => builder(ctx));

  if (allConditions.length === 0) {
    return undefined;
  }

  return sql`WHERE ${sql.join(allConditions, sql` AND `)}`;
}

/**
 * Joins conditions into a WHERE clause RawBuilder.
 * Lower-level than composeConditions - takes raw condition arrays.
 *
 * @param conditions - Array of SqlCondition RawBuilders
 * @returns RawBuilder for WHERE clause, or undefined if no conditions
 */
export function toWhereClause(conditions: SqlCondition[]): RawBuilder<unknown> | undefined {
  if (conditions.length === 0) {
    return undefined;
  }
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
}

// ============================================================================
// Condition Combinators
// ============================================================================

/**
 * Joins conditions with AND.
 *
 * @param conditions - Array of SqlCondition RawBuilders
 * @returns Single RawBuilder with AND joins, or sql`TRUE` if empty
 */
export function andConditions(conditions: SqlCondition[]): RawBuilder<unknown> {
  if (conditions.length === 0) {
    return sql`TRUE`;
  }
  if (conditions.length === 1) {
    const first = conditions[0];
    if (first !== undefined) {
      return first;
    }
    return sql`TRUE`;
  }
  return sql.join(conditions, sql` AND `);
}

/**
 * Joins conditions with OR, wrapped in parentheses.
 *
 * @param conditions - Array of SqlCondition RawBuilders
 * @returns Single RawBuilder with OR joins, parenthesized
 */
export function orConditions(conditions: SqlCondition[]): RawBuilder<unknown> {
  if (conditions.length === 0) {
    return sql`FALSE`;
  }
  if (conditions.length === 1) {
    const first = conditions[0];
    if (first !== undefined) {
      return first;
    }
    return sql`FALSE`;
  }
  return sql`(${sql.join(conditions, sql` OR `)})`;
}

// ============================================================================
// LIKE Pattern Utilities
// ============================================================================

/**
 * Escapes LIKE pattern wildcards in a string.
 *
 * SECURITY NOTE: This does NOT prevent SQL injection - that's handled by
 * Kysely's parameterization. This only escapes LIKE metacharacters (%, _)
 * so they match literally instead of acting as wildcards.
 *
 * @param value - Raw string to escape
 * @returns String with LIKE wildcards escaped
 *
 * @example
 * ```ts
 * // User searching for "50%"
 * const escaped = escapeLikeWildcards("50%"); // "50\\%"
 * sql`col LIKE ${escaped + '%'}`; // Matches "50%..." not "50..."
 * ```
 */
export function escapeLikeWildcards(value: string): string {
  return value
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/%/g, '\\%') // Escape LIKE wildcard
    .replace(/_/g, '\\_'); // Escape single-char wildcard
}

// ============================================================================
// Numeric Utilities
// ============================================================================

/**
 * Converts an array of string IDs to numeric IDs, filtering out invalid values.
 *
 * @param ids - Array of string IDs
 * @returns Array of valid numeric IDs
 */
export function toNumericIds(ids: readonly string[]): number[] {
  return ids
    .filter((id) => id.trim() !== '')
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

/**
 * Validates that a value is a finite number.
 *
 * @param value - Value to validate
 * @returns true if value is a finite number
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ============================================================================
// Array Utilities
// ============================================================================

/**
 * Checks if an array has values (non-empty).
 * Type guard that narrows undefined arrays.
 */
export function hasValues<T>(arr: readonly T[] | undefined): arr is readonly T[] {
  return arr !== undefined && arr.length > 0;
}
