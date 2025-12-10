/**
 * Dimension Filter
 *
 * Builds parameterized SQL conditions for dimensional filters:
 * account_category, report_type, entity_cuis, funding_source_ids, etc.
 *
 * SECURITY: All values are automatically parameterized via Kysely's sql`` template.
 */

import { sql } from 'kysely';

import { col, hasValues, toNumericIds } from './composer.js';

import type { FilterContext, SqlCondition, DimensionFilter } from './types.js';

// ============================================================================
// SQL Condition Builders (Parameterized)
// ============================================================================

/**
 * Builds parameterized SQL conditions for dimension filters.
 *
 * @param filter - Filter with dimension constraints
 * @param ctx - Filter context with table aliases
 * @returns Array of parameterized SqlCondition RawBuilders
 */
export function buildDimensionConditions(
  filter: DimensionFilter,
  ctx: FilterContext
): SqlCondition[] {
  const a = ctx.lineItemAlias;
  const conditions: SqlCondition[] = [];

  // Required filter: account_category (value is parameterized)
  conditions.push(sql`${col(a, 'account_category')} = ${filter.account_category}`);

  // Optional filters - all values are parameterized
  if (filter.report_type !== undefined) {
    conditions.push(sql`${col(a, 'report_type')} = ${filter.report_type}`);
  }

  if (filter.main_creditor_cui !== undefined) {
    conditions.push(sql`${col(a, 'main_creditor_cui')} = ${filter.main_creditor_cui}`);
  }

  // Array filters using sql.join for safe IN clauses
  if (hasValues(filter.report_ids)) {
    conditions.push(sql`${col(a, 'report_id')} IN (${sql.join(filter.report_ids)})`);
  }

  if (hasValues(filter.entity_cuis)) {
    conditions.push(sql`${col(a, 'entity_cui')} IN (${sql.join(filter.entity_cuis)})`);
  }

  if (hasValues(filter.funding_source_ids)) {
    const ids = toNumericIds(filter.funding_source_ids);
    if (ids.length > 0) {
      conditions.push(sql`${col(a, 'funding_source_id')} IN (${sql.join(ids)})`);
    }
  }

  if (hasValues(filter.budget_sector_ids)) {
    const ids = toNumericIds(filter.budget_sector_ids);
    if (ids.length > 0) {
      conditions.push(sql`${col(a, 'budget_sector_id')} IN (${sql.join(ids)})`);
    }
  }

  if (hasValues(filter.expense_types)) {
    conditions.push(sql`${col(a, 'expense_type')} IN (${sql.join(filter.expense_types)})`);
  }

  return conditions;
}
