/**
 * Judicial repo — filter-input + cursor helpers (plan 08 §4/§7).
 *
 * `judicial_cases` has TWO virtual fields the kernel composer must NOT compile:
 * `courtLevel` (a bounded join to justice.courts) and `year` (derived from
 * source_opened_at). `splitVirtual` separates them so the kernel composes the
 * physical predicates and the repo intercepts the virtuals. The keyset cursor is
 * `(sortExpr, case_id)` with case_id the bigint tiebreaker.
 */

import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CollectionFilterSpec,
  type FieldFilter,
  type FilterInput,
  toConditionBuilders,
} from '@/modules/shared/index.js';

/** Join a list of conditions with AND (TRUE if empty). */
export const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** Compile the spec's kernel-composed (non-virtual) conditions (TRUE if none). */
export const kernelConditions = (
  spec: CollectionFilterSpec,
  input: FilterInput
): Result<RawBuilder<SqlBool>, ApiError> => {
  const built = toConditionBuilders(spec, input);
  if (built.isErr()) return err(built.error);
  return ok(composeWhere(built.value));
};

/** Clamp a list `first` into [1, max]. */
export const clampLimit = (first: number, max: number): number =>
  Math.min(Math.max(Math.floor(first), 1), max);

/** Read a field-filter off a raw filter input (typed access). */
export const fieldOf = (input: FilterInput, name: string): FieldFilter | undefined => {
  const v = input[name];
  return typeof v === 'object' && !Array.isArray(v) ? v : undefined;
};

/** Coerce an `in:` value to a string[] (drops non-strings; empty array preserved). */
export const inStrings = (ff: FieldFilter | undefined): readonly string[] | undefined => {
  if (ff === undefined) return undefined;
  const v = ff['in'];
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x));
};

/** Read an `isNull:` boolean off a field-filter. */
export const isNullOf = (ff: FieldFilter | undefined): boolean | undefined => {
  if (ff === undefined) return undefined;
  const v = ff['isNull'];
  return typeof v === 'boolean' ? v : undefined;
};

/**
 * Read the `year` virtual field's bounds as `{ from, to }` opened-years. Supports
 * `eq` (from=to), `gte`/`lte`, and `between {from,to}`. Returns null if absent.
 */
export const yearBounds = (
  ff: FieldFilter | undefined
): { from: number | null; to: number | null } | null => {
  if (ff === undefined) return null;
  const toInt = (x: unknown): number | null => {
    const n = typeof x === 'number' ? x : Number(x);
    return Number.isInteger(n) ? n : null;
  };
  let from: number | null = null;
  let to: number | null = null;
  if (ff['eq'] !== undefined) {
    const y = toInt(ff['eq']);
    from = y;
    to = y;
  }
  if (ff['gte'] !== undefined) from = toInt(ff['gte']);
  if (ff['lte'] !== undefined) to = toInt(ff['lte']);
  const between = ff['between'];
  if (typeof between === 'object' && !Array.isArray(between)) {
    const b = between as { from?: unknown; to?: unknown };
    if (b.from !== undefined) from = toInt(b.from);
    if (b.to !== undefined) to = toInt(b.to);
  }
  if (from === null && to === null) return null;
  return { from, to };
};

/**
 * True if a `between`/`gte`/`lte` field-filter carries a REAL date/value bound
 * (not an empty `{}` or `between:{}`). Mirrors the §7.1 "empty is not a bound"
 * rule so `modified:{between:{}}` cannot masquerade as bounded (codex P1).
 */
export const hasRangeBound = (ff: FieldFilter | undefined): boolean => {
  if (ff === undefined) return false;
  if (ff['gte'] !== undefined || ff['lte'] !== undefined) return true;
  const between = ff['between'];
  if (typeof between === 'object' && !Array.isArray(between)) {
    const b = between as { from?: unknown; to?: unknown };
    return b.from !== undefined || b.to !== undefined;
  }
  return false;
};

/** The sort-value cast kind for the keyset cursor. */
export type SortCast = 'date' | 'text';

const castValue = (cVal: string, cast: SortCast): RawBuilder<unknown> =>
  cast === 'date' ? sql`${cVal}::timestamptz` : sql`${cVal}`;

/**
 * Build the `(sortExpr, case_id)` keyset cursor predicate. `caseId` is the bigint
 * tiebreaker compared `::bigint` (NOT text — '9' vs '100' would mis-sort). NULL
 * sort values sort LAST in both directions; a NULL cursor sort value is the
 * empty-string sentinel.
 */
export const keysetCursor = (
  sortExpr: RawBuilder<unknown>,
  cast: SortCast,
  cVal: string,
  cCaseId: string,
  dir: 'asc' | 'desc'
): RawBuilder<unknown> => {
  const idCol = sql`c.case_id`;
  const k = sql`${cCaseId}::bigint`;
  const cmp = dir === 'desc' ? sql`<` : sql`>`;
  if (cVal === '') {
    // Already inside the NULL-sort section: only the case_id tiebreak applies.
    return sql`(${sortExpr} is null and ${idCol} ${cmp} ${k})`;
  }
  const v = castValue(cVal, cast);
  // NULLS LAST in both directions: the trailing null-sort section comes AFTER every
  // non-null row, so from a non-null cursor we must keep `sortExpr IS NULL` rows
  // reachable in both directions.
  return sql`(${sortExpr} ${cmp} ${v} or ${sortExpr} is null or (${sortExpr} = ${v} and ${idCol} ${cmp} ${k}))`;
};
