/**
 * Column Reference System
 *
 * Provides type-safe column references for SQL queries.
 * This module encapsulates sql.raw() usage for column identifiers,
 * ensuring that only valid column names from the schema can be used.
 *
 * SECURITY: Column names are validated against known schema at compile time.
 * The sql.raw() usage here is safe because we only accept predefined column names.
 */

import { sql, type RawBuilder } from 'kysely';

import {
  ExecutionLineItemColumns,
  EntityColumns,
  UatColumns,
  FunctionalClassificationColumns,
  EconomicClassificationColumns,
  ReportColumns,
  AggregateColumns,
  AmountColumnByFrequency,
  type TableAlias,
  type ExecutionLineItemColumn,
  type EntityColumn,
  type UatColumn,
  type FunctionalClassificationColumn,
  type EconomicClassificationColumn,
  type ReportColumn,
  type AggregateColumn,
  type AmountColumn,
} from './identifiers.js';

import type { Frequency } from '@/common/types/temporal.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Union of all valid column names across all tables.
 * Note: Some column names overlap between tables (e.g., entity_cui exists in multiple)
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Intentional: includes all tables for completeness */
export type AnyColumn =
  | ExecutionLineItemColumn
  | EntityColumn
  | UatColumn
  | FunctionalClassificationColumn
  | EconomicClassificationColumn
  | ReportColumn
  | AggregateColumn;
/* eslint-enable @typescript-eslint/no-redundant-type-constituents -- End of AnyColumn type */

/**
 * Maps table aliases to their valid columns.
 */
export type ColumnForAlias<T extends TableAlias> = T extends 'eli'
  ? ExecutionLineItemColumn
  : T extends 'e'
    ? EntityColumn
    : T extends 'u'
      ? UatColumn
      : T extends 'fc'
        ? FunctionalClassificationColumn
        : T extends 'ec'
          ? EconomicClassificationColumn
          : T extends 'r'
            ? ReportColumn
            : T extends 'fa' | 'cp' | 'f'
              ? AggregateColumn
              : never;

// ============================================================================
// Column Validation
// ============================================================================

/**
 * Set of all valid column names for fast lookup.
 */
const ALL_VALID_COLUMNS = new Set<string>([
  ...Object.keys(ExecutionLineItemColumns),
  ...Object.keys(EntityColumns),
  ...Object.keys(UatColumns),
  ...Object.keys(FunctionalClassificationColumns),
  ...Object.keys(EconomicClassificationColumns),
  ...Object.keys(ReportColumns),
  ...Object.keys(AggregateColumns),
]);

/**
 * Valid table aliases.
 */
const VALID_ALIASES = new Set<string>(['eli', 'e', 'u', 'fc', 'ec', 'r', 'cp', 'f', 'fa']);

/**
 * Validates that a column name is in our schema.
 * This is a runtime check in addition to TypeScript's compile-time check.
 */
function isValidColumn(column: string): boolean {
  return ALL_VALID_COLUMNS.has(column);
}

/**
 * Validates that an alias is valid.
 */
function isValidAlias(alias: string): boolean {
  return VALID_ALIASES.has(alias);
}

// ============================================================================
// Column Reference Functions
// ============================================================================

/**
 * Creates a qualified column reference (alias.column).
 *
 * @param alias - Table alias (must be a valid TableAlias)
 * @param column - Column name (must be valid for the alias)
 * @returns RawBuilder containing the qualified column reference
 *
 * @example
 * ```typescript
 * // Type-safe: 'year' must be a valid ExecutionLineItemColumn
 * const col = columnRef('eli', 'year');
 * // Produces: eli.year
 *
 * // Type error: 'invalid' is not a valid column
 * const bad = columnRef('eli', 'invalid');
 * ```
 */
export function columnRef<T extends TableAlias>(
  alias: T,
  column: ColumnForAlias<T>
): RawBuilder<unknown> {
  // Runtime validation (in addition to TypeScript compile-time check)
  if (!isValidAlias(alias)) {
    throw new Error(`Invalid table alias: ${alias}`);
  }
  const colStr = column as string;
  if (!isValidColumn(colStr)) {
    throw new Error(`Invalid column name: ${colStr}`);
  }

  // SECURITY: Both alias and column are validated against known values.
  // This sql.raw() is safe because we only accept predefined identifiers.

  return sql.raw(`${alias}.${colStr}`);
}

/**
 * Creates an unqualified column reference (just the column name).
 *
 * Use this for columns in SELECT that don't need table qualification,
 * or for aggregate result columns.
 *
 * @param column - Column name
 * @returns RawBuilder containing the column reference
 *
 * @example
 * ```typescript
 * const col = column('total_amount');
 * // Produces: total_amount
 * ```
 */
export function column(col: AnyColumn): RawBuilder<unknown> {
  if (!isValidColumn(col)) {
    throw new Error(`Invalid column name: ${col}`);
  }

  // SECURITY: Column is validated against known values.

  return sql.raw(col);
}

/**
 * Gets the amount column name for a given frequency.
 *
 * @param frequency - Time frequency (MONTH, QUARTER, YEAR)
 * @returns The appropriate amount column name
 *
 * @example
 * ```typescript
 * getAmountColumn('MONTH')   // 'monthly_amount'
 * getAmountColumn('QUARTER') // 'quarterly_amount'
 * getAmountColumn('YEAR')    // 'ytd_amount'
 * ```
 */
export function getAmountColumn(frequency: Frequency): AmountColumn {
  const frequencyKey = frequency.toUpperCase() as keyof typeof AmountColumnByFrequency;
  // AmountColumnByFrequency has entries for all valid Frequency values
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive check
  const col = AmountColumnByFrequency[frequencyKey] ?? 'ytd_amount';

  return col;
}

/**
 * Creates a qualified amount column reference for a given frequency.
 *
 * @param alias - Table alias
 * @param frequency - Time frequency
 * @returns RawBuilder for the amount column
 *
 * @example
 * ```typescript
 * amountColumnRef('eli', 'MONTH')
 * // Produces: eli.monthly_amount
 * ```
 */
export function amountColumnRef(alias: 'eli', frequency: Frequency): RawBuilder<unknown> {
  const col = getAmountColumn(frequency);

  return sql.raw(`${alias}.${col}`);
}

/**
 * Creates a COALESCE(SUM(...), 0) expression for the amount column.
 *
 * Used for aggregate thresholds in HAVING clauses.
 *
 * @param alias - Table alias
 * @param frequency - Time frequency
 * @returns RawBuilder for the expression
 *
 * @example
 * ```typescript
 * coalesceSumAmountExpr('eli', 'MONTH')
 * // Produces: COALESCE(SUM(eli.monthly_amount), 0)
 * ```
 */
export function coalesceSumAmountExpr(alias: 'eli', frequency: Frequency): RawBuilder<unknown> {
  const col = getAmountColumn(frequency);

  return sql.raw(`COALESCE(SUM(${alias}.${col}), 0)`);
}
