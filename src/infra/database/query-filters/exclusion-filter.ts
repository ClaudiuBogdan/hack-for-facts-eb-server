/**
 * Exclusion Filter
 *
 * Builds parameterized SQL conditions for NOT IN / exclusion filters.
 *
 * IMPORTANT: For nullable columns (entity_type, uat_id, county_code),
 * we use (column IS NULL OR column NOT IN (...)) to preserve NULL rows.
 * SQL's NOT IN does not match NULL values.
 *
 * SECURITY: All values are automatically parameterized via Kysely's sql`` template.
 */

import { sql } from 'kysely';

import { col, hasValues, toNumericIds, escapeLikeWildcards } from './composer.js';

import type { FilterContext, SqlCondition, ExclusionFilter } from './types.js';

// ============================================================================
// SQL Condition Builders (Parameterized)
// ============================================================================

/**
 * Builds parameterized SQL conditions for exclusion filters.
 *
 * @param exclude - Exclusion filter with values to exclude
 * @param accountCategory - Account category (vn/ch) for economic code handling
 * @param ctx - Filter context with table aliases and join state
 * @returns Array of parameterized SqlCondition RawBuilders
 */
export function buildExclusionConditions(
  exclude: ExclusionFilter,
  accountCategory: string,
  ctx: FilterContext
): SqlCondition[] {
  const eli = ctx.lineItemAlias;
  const e = ctx.entityAlias;
  const u = ctx.uatAlias;
  const conditions: SqlCondition[] = [];

  // Line item exclusions (non-nullable columns)
  if (hasValues(exclude.report_ids)) {
    conditions.push(sql`${col(eli, 'report_id')} NOT IN (${sql.join(exclude.report_ids)})`);
  }

  if (hasValues(exclude.entity_cuis)) {
    conditions.push(sql`${col(eli, 'entity_cui')} NOT IN (${sql.join(exclude.entity_cuis)})`);
  }

  // Functional code exclusions
  if (hasValues(exclude.functional_codes)) {
    conditions.push(
      sql`${col(eli, 'functional_code')} NOT IN (${sql.join(exclude.functional_codes)})`
    );
  }

  // Functional prefix exclusions (LIKE patterns)
  if (hasValues(exclude.functional_prefixes)) {
    const prefixConditions = exclude.functional_prefixes.map(
      (p) => sql`${col(eli, 'functional_code')} NOT LIKE ${escapeLikeWildcards(p) + '%'}`
    );
    conditions.push(sql`(${sql.join(prefixConditions, sql` AND `)})`);
  }

  // Economic exclusions only apply to non-VN accounts (per spec)
  if (accountCategory !== 'vn') {
    if (hasValues(exclude.economic_codes)) {
      conditions.push(
        sql`${col(eli, 'economic_code')} NOT IN (${sql.join(exclude.economic_codes)})`
      );
    }

    if (hasValues(exclude.economic_prefixes)) {
      const prefixConditions = exclude.economic_prefixes.map(
        (p) => sql`${col(eli, 'economic_code')} NOT LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      conditions.push(sql`(${sql.join(prefixConditions, sql` AND `)})`);
    }
  }

  // Entity exclusions (NULL-safe) - only if entity table is joined
  if (ctx.hasEntityJoin) {
    if (hasValues(exclude.entity_types)) {
      conditions.push(
        sql`(${col(e, 'entity_type')} IS NULL OR ${col(e, 'entity_type')} NOT IN (${sql.join(exclude.entity_types)}))`
      );
    }

    if (hasValues(exclude.uat_ids)) {
      const ids = toNumericIds(exclude.uat_ids);
      if (ids.length > 0) {
        conditions.push(
          sql`(${col(e, 'uat_id')} IS NULL OR ${col(e, 'uat_id')} NOT IN (${sql.join(ids)}))`
        );
      }
    }
  }

  // UAT exclusions (NULL-safe) - only if UAT table is joined
  if (ctx.hasUatJoin) {
    if (hasValues(exclude.county_codes)) {
      conditions.push(
        sql`(${col(u, 'county_code')} IS NULL OR ${col(u, 'county_code')} NOT IN (${sql.join(exclude.county_codes)}))`
      );
    }

    if (hasValues(exclude.regions)) {
      conditions.push(
        sql`(${col(u, 'region')} IS NULL OR ${col(u, 'region')} NOT IN (${sql.join(exclude.regions)}))`
      );
    }
  }

  return conditions;
}
