/**
 * Shared Kernel — SQL condition composer (foundation §7.1, §14.2).
 *
 * SECURITY: every user value is parameterized via Kysely's `sql``` template
 * tag. Column/alias identifiers are validated by `safeColumnRef` (the only
 * place this module emits `sql.ref`/raw identifiers) against a strict charset,
 * so injection is impossible by design. Per-source repos compose conditions;
 * they never concatenate input into SQL.
 */

import { sql, type RawBuilder } from 'kysely';

import type { FilterColumn, SqlCondition } from './types.js';

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/iu;
const CAST_RE = /^::[a-z_][a-z0-9_ ]*(\[\])?$/iu;

/**
 * Build a validated, parameterizable column reference: `alias.column[::cast]`.
 * Throws on a malformed identifier — these are trusted internal values from the
 * filter spec, so a bad one is a programming error, not user input.
 */
export const safeColumnRef = (column: FilterColumn): RawBuilder<unknown> => {
  if (!IDENTIFIER_RE.test(column.alias) || !IDENTIFIER_RE.test(column.column)) {
    // Invariant on trusted spec data (a malformed identifier is a programming
    // error, not an expected runtime failure) — hence a throw, not a Result.
    // eslint-disable-next-line no-restricted-syntax -- spec invariant, not expected failure
    throw new Error(`unsafe column reference: ${column.alias}.${column.column}`);
  }
  const ref = sql.ref(`${column.alias}.${column.column}`);
  if (column.cast !== undefined) {
    if (!CAST_RE.test(column.cast)) {
      // eslint-disable-next-line no-restricted-syntax -- spec invariant, not expected failure
      throw new Error(`unsafe cast: ${column.cast}`);
    }
    // `cast` matched a strict whitelist; sql.raw is safe here only.
    return sql`${ref}${sql.raw(column.cast)}`;
  }
  return ref;
};

/** Join conditions with AND into a single boolean expression (TRUE if empty). */
export const andConditions = (conditions: readonly SqlCondition[]): RawBuilder<unknown> => {
  if (conditions.length === 0) return sql`TRUE`;
  if (conditions.length === 1) return conditions[0] ?? sql`TRUE`;
  return sql.join(conditions, sql` AND `);
};

/** Join conditions with OR, parenthesized (FALSE if empty). */
export const orConditions = (conditions: readonly SqlCondition[]): RawBuilder<unknown> => {
  if (conditions.length === 0) return sql`FALSE`;
  if (conditions.length === 1) return conditions[0] ?? sql`FALSE`;
  return sql`(${sql.join(conditions, sql` OR `)})`;
};

/**
 * Compose builders into a `WHERE ...` clause, or `undefined` when there are no
 * conditions (so callers can omit the WHERE entirely).
 */
export const composeWhere = (
  ...conditions: readonly SqlCondition[]
): RawBuilder<unknown> | undefined => {
  if (conditions.length === 0) return undefined;
  return sql`where ${sql.join(conditions, sql` and `)}`;
};

/** Escape LIKE/ILIKE metacharacters so they match literally. */
export const escapeLike = (value: string): string =>
  value.replace(/\\/gu, '\\\\').replace(/%/gu, '\\%').replace(/_/gu, '\\_');
