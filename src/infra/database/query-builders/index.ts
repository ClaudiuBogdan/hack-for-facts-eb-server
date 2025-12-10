/**
 * Query Builders
 *
 * Safe SQL construction utilities that encapsulate sql.raw() usage.
 * Repositories should import from this module instead of using sql.raw() directly.
 *
 * SECURITY: This module is the ONLY place where sql.raw() should be used.
 * All identifiers are validated against the known database schema.
 * ESLint rules ban sql.raw() usage in repository code.
 *
 * @example
 * ```typescript
 * import {
 *   setStatementTimeout,
 *   columnRef,
 *   column,
 *   amountColumnRef,
 *   CommonJoins,
 *   CommonOrderBy,
 *   CommonGroupBy,
 * } from '@/infra/database/query-builders/index.js';
 *
 * // Set timeout safely
 * await setStatementTimeout(db, 30_000);
 *
 * // Type-safe column references
 * const yearCol = columnRef('eli', 'year');
 * const amountCol = amountColumnRef('eli', 'MONTH');
 *
 * // Pre-built common expressions
 * const entityJoin = CommonJoins.entityOnLineItem();
 * const orderBy = CommonOrderBy.yearAsc();
 * ```
 */

// ============================================================================
// Timeout
// ============================================================================

export {
  setStatementTimeout,
  withTimeout,
  DEFAULT_QUERY_TIMEOUT_MS,
  MAX_QUERY_TIMEOUT_MS,
  MIN_QUERY_TIMEOUT_MS,
} from './timeout.js';

// ============================================================================
// Identifiers (Types and Constants)
// ============================================================================

export {
  // Table aliases
  TableAliases,
  type TableAlias,

  // Table names
  TableNames,
  type TableName,

  // Column definitions
  ExecutionLineItemColumns,
  EntityColumns,
  UatColumns,
  FunctionalClassificationColumns,
  EconomicClassificationColumns,
  ReportColumns,
  AggregateColumns,

  // Column types
  type ExecutionLineItemColumn,
  type EntityColumn,
  type UatColumn,
  type FunctionalClassificationColumn,
  type EconomicClassificationColumn,
  type ReportColumn,
  type AggregateColumn,

  // Amount columns
  AmountColumnByFrequency,
  type AmountColumn,
} from './identifiers.js';

// ============================================================================
// Column References
// ============================================================================

export {
  // Column reference functions
  columnRef,
  column,
  amountColumnRef,
  getAmountColumn,
  coalesceSumAmountExpr,

  // Types
  type AnyColumn,
  type ColumnForAlias,
} from './columns.js';

// ============================================================================
// SQL Expressions
// ============================================================================

export {
  // Join expressions
  joinClause,
  noJoin,
  CommonJoins,
  type JoinType,

  // Order By
  orderByClause,
  CommonOrderBy,
  type SortDirection,
  type NullsPosition,

  // Group By
  groupByClause,
  CommonGroupBy,

  // Aggregate expressions
  coalesce,
  sumExpr,
  coalesceSumExpr,
  countExpr,
  countOverExpr,

  // Classification helpers
  UNKNOWN_ECONOMIC_CODE,
  UNKNOWN_ECONOMIC_NAME,
  coalesceEconomicCode,
  coalesceEconomicName,

  // Entity analytics sorting
  getEntityAnalyticsSortColumn,
  entityAnalyticsOrderBy,
  type EntityAnalyticsSortField,
} from './expressions.js';
