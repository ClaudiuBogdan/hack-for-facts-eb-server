/**
 * Query Filters
 *
 * Composable, parameterized SQL filter building utilities for analytics repositories.
 * Uses Kysely's RawBuilder for automatic SQL injection prevention.
 *
 * SECURITY: All user values are automatically parameterized via sql`` template tag.
 * The database receives parameterized queries (e.g., `WHERE col = $1`), never raw values.
 *
 * Usage:
 * ```ts
 * import {
 *   createFilterContext,
 *   buildPeriodConditions,
 *   buildDimensionConditions,
 *   andConditions,
 *   needsEntityJoin,
 * } from '@/infra/database/query-filters';
 *
 * const ctx = createFilterContext({
 *   hasEntityJoin: needsEntityJoin(filter),
 *   hasUatJoin: needsUatJoin(filter),
 * });
 *
 * const conditions = [
 *   ...buildPeriodConditions(filter.report_period.selection, frequency, ctx),
 *   ...buildDimensionConditions(filter, ctx),
 *   ...buildCodeConditions(filter, ctx),
 * ];
 *
 * // Use in query - no sql.raw() needed!
 * const query = sql`
 *   SELECT * FROM table
 *   WHERE ${andConditions(conditions)}
 * `;
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  // Core types
  FilterContext,
  SqlCondition,
  ConditionBuilder,

  // Parsed period types
  ParsedPeriod,
  MonthPeriod,
  QuarterPeriod,
  PeriodSelection,
  ReportPeriod,

  // Filter interfaces
  DimensionFilter,
  CodeFilter,
  GeographicFilter,
  AmountFilter,
  ExclusionFilter,
  AnalyticsSqlFilter,
} from './types.js';

export { createFilterContext } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Period Filters
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Period parsing
  parsePeriodDate,
  extractYear,
  formatDateFromRow,
  parseMonthPeriods,
  parseQuarterPeriods,
  parseYears,

  // Condition builder
  buildPeriodConditions,
} from './period-filter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dimension Filters
// ─────────────────────────────────────────────────────────────────────────────

export { buildDimensionConditions } from './dimension-filter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Code Filters
// ─────────────────────────────────────────────────────────────────────────────

export { buildCodeConditions } from './code-filter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Entity Filters
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Join detection
  needsEntityJoin,
  needsUatJoin,

  // Condition builders
  buildEntityConditions,
  buildUatConditions,
} from './entity-filter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion Filters
// ─────────────────────────────────────────────────────────────────────────────

export { buildExclusionConditions } from './exclusion-filter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Amount Filters
// ─────────────────────────────────────────────────────────────────────────────

export { getAmountColumnName, buildAmountConditions } from './amount-filter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Composition Utilities
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Column reference helper
  col,

  // Condition composition
  composeConditions,
  toWhereClause,
  andConditions,
  orConditions,

  // LIKE pattern utilities
  escapeLikeWildcards,

  // Numeric utilities
  toNumericIds,
  isFiniteNumber,

  // Array utilities
  hasValues,
} from './composer.js';
