/**
 * Amount Filter
 *
 * Builds parameterized SQL conditions for amount constraints (min/max).
 * Handles frequency-specific amount columns.
 *
 * SECURITY: All values are automatically parameterized via Kysely's sql`` template.
 */

import { sql } from 'kysely';

import { Frequency } from '@/common/types/temporal.js';

import { col, isFiniteNumber } from './composer.js';

import type { FilterContext, SqlCondition, AmountFilter } from './types.js';
import type { AmountColumn } from '@/infra/database/query-builders/index.js';

// ============================================================================
// Column Selection
// ============================================================================

/**
 * Gets the appropriate amount column name based on frequency.
 *
 * @param frequency - Time frequency (MONTH, QUARTER, YEAR)
 * @returns Column name (without alias)
 */
export function getAmountColumnName(frequency: Frequency): AmountColumn {
  if (frequency === Frequency.MONTH) {
    return 'monthly_amount';
  }
  if (frequency === Frequency.QUARTER) {
    return 'quarterly_amount';
  }
  return 'ytd_amount';
}

// ============================================================================
// SQL Condition Builders (Parameterized)
// ============================================================================

/**
 * Builds parameterized SQL conditions for amount constraints.
 *
 * @param filter - Filter with amount constraints
 * @param frequency - Time frequency (determines which amount column to use)
 * @param ctx - Filter context with table aliases
 * @returns Array of parameterized SqlCondition RawBuilders
 */
export function buildAmountConditions(
  filter: AmountFilter,
  frequency: Frequency,
  ctx: FilterContext
): SqlCondition[] {
  const conditions: SqlCondition[] = [];
  const columnName = getAmountColumnName(frequency);
  const column = col(ctx.lineItemAlias, columnName);

  // Validate numeric values before using them (defense in depth)
  if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
    if (isFiniteNumber(filter.item_min_amount)) {
      conditions.push(sql`${column} >= ${filter.item_min_amount}`);
    }
  }

  if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
    if (isFiniteNumber(filter.item_max_amount)) {
      conditions.push(sql`${column} <= ${filter.item_max_amount}`);
    }
  }

  return conditions;
}
