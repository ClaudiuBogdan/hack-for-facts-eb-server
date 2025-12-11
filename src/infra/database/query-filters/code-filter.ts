/**
 * Code Filter
 *
 * Builds parameterized SQL conditions for classification code filters:
 * functional_codes, economic_codes, program_codes, and their prefix variants.
 *
 * SECURITY: All values are automatically parameterized via Kysely's sql`` template.
 */

import { sql } from 'kysely';

import { col, hasValues, escapeLikeWildcards } from './composer.js';

import type { FilterContext, SqlCondition, CodeFilter } from './types.js';

// ============================================================================
// SQL Condition Builders (Parameterized)
// ============================================================================

/**
 * Builds parameterized SQL conditions for classification code filters.
 *
 * Supports both exact matches and prefix-based filtering (LIKE patterns).
 * LIKE patterns use parameterized values - wildcards in user input are escaped.
 *
 * @param filter - Filter with code constraints
 * @param ctx - Filter context with table aliases
 * @returns Array of parameterized SqlCondition RawBuilders
 */
export function buildCodeConditions(filter: CodeFilter, ctx: FilterContext): SqlCondition[] {
  const a = ctx.lineItemAlias;
  const conditions: SqlCondition[] = [];

  // Exact functional codes (IN clause with parameterized values)
  if (hasValues(filter.functional_codes)) {
    conditions.push(sql`${col(a, 'functional_code')} IN (${sql.join(filter.functional_codes)})`);
  }

  // Functional code prefixes (LIKE patterns with parameterized values)
  // escapeLikeWildcards prevents user wildcards from acting as SQL wildcards
  if (hasValues(filter.functional_prefixes)) {
    const prefixConditions = filter.functional_prefixes.map(
      (p) => sql`${col(a, 'functional_code')} LIKE ${escapeLikeWildcards(p) + '%'}`
    );
    conditions.push(sql`(${sql.join(prefixConditions, sql` OR `)})`);
  }

  // Exact economic codes
  if (hasValues(filter.economic_codes)) {
    conditions.push(sql`${col(a, 'economic_code')} IN (${sql.join(filter.economic_codes)})`);
  }

  // Economic code prefixes
  if (hasValues(filter.economic_prefixes)) {
    const prefixConditions = filter.economic_prefixes.map(
      (p) => sql`${col(a, 'economic_code')} LIKE ${escapeLikeWildcards(p) + '%'}`
    );
    conditions.push(sql`(${sql.join(prefixConditions, sql` OR `)})`);
  }

  // Program codes
  if (hasValues(filter.program_codes)) {
    conditions.push(sql`${col(a, 'program_code')} IN (${sql.join(filter.program_codes)})`);
  }

  return conditions;
}
