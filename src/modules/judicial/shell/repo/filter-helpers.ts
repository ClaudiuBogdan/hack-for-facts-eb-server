/**
 * Judicial repo — filter-input + cursor helpers (plan 08 §4/§7).
 *
 * `judicial_cases` has TWO virtual fields the kernel composer must NOT compile:
 * `courtLevel` (a bounded join to justice.courts) and `year` (derived from
 * source_opened_at). `splitVirtual` separates them so the kernel composes the
 * physical predicates and the repo intercepts the virtuals. The keyset cursor is
 * `(sortExpr, case_id)` with case_id the bigint tiebreaker.
 *
 * INPUT NORMALIZATION (A3): every judicial filter passes `normalizeJudicialFilter`
 * BEFORE bounding, hashing, SQL composition or a repo call, so all of them see
 * the SAME object. Null means absent only at optional positions; shapes and the
 * virtual fields are validated here as typed InvalidInput; the year interval is
 * intersected once and compiled once.
 */

import { Value } from '@sinclair/typebox/value';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  toTypeBox,
  type ApiError,
  type CollectionFilterSpec,
  type FieldFilter,
  type FilterFieldSpec,
  type FilterInput,
  type FilterValue,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { isJudicialYearOperand } from '../../core/types.js';

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

// ── A3: local normalization of judicial filter inputs ──────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The ORIGINAL type an operand of this field must already have (never coerced). */
const operandHasFieldType = (field: FilterFieldSpec, op: string, value: unknown): boolean => {
  if (op === 'isNull') return typeof value === 'boolean';
  switch (field.type) {
    case 'int':
    case 'number':
      return typeof value === 'number';
    case 'bool':
      return typeof value === 'boolean';
    default:
      return typeof value === 'string';
  }
};

const RANGE_ENDPOINTS: ReadonlySet<string> = new Set(['from', 'to']);

/**
 * Normalize one operand. Returns `undefined` when the operand is absent after
 * normalization (an all-null range). Messages name only spec-owned fields; a
 * caller-supplied key or value is never echoed.
 */
const normalizeOperand = (
  field: FilterFieldSpec,
  op: string,
  value: unknown
): Result<FilterValue | undefined, ApiError> => {
  if (op === 'between') {
    if (!isPlainObject(value)) {
      return err(
        invalidInput(`${field.name} between requires an object with from or to`, field.name)
      );
    }
    const range: { from?: string | number; to?: string | number } = {};
    for (const [endpoint, bound] of Object.entries(value)) {
      if (!RANGE_ENDPOINTS.has(endpoint)) {
        return err(invalidInput(`${field.name} between accepts only from and to`, field.name));
      }
      if (bound === undefined || bound === null) continue;
      if (!operandHasFieldType(field, op, bound)) {
        return err(invalidInput(`${field.name} range bound has the wrong type`, field.name));
      }
      range[endpoint as 'from' | 'to'] = bound as string | number;
    }
    return ok(Object.keys(range).length === 0 ? undefined : range);
  }
  if (op === 'in') {
    if (!Array.isArray(value)) {
      return err(invalidInput(`${field.name} in requires a list`, field.name));
    }
    // A null or wrongly typed member is an error: it is never dropped (which
    // could turn an invalid list into a valid one) and never stringified.
    for (const member of value as readonly unknown[]) {
      if (member === null || member === undefined || !operandHasFieldType(field, op, member)) {
        return err(invalidInput(`${field.name} list members have the wrong type`, field.name));
      }
    }
    return ok([...(value as readonly (string | number)[])]);
  }
  if (!operandHasFieldType(field, op, value)) {
    return err(invalidInput(`${field.name} operand has the wrong type`, field.name));
  }
  return ok(value as FilterValue);
};

/**
 * Normalize a judicial filter (cases or courts spec). Omitted and explicit-null
 * filter objects, fields, operators and range endpoints mean ABSENT; a range or
 * field that empties is dropped, so an empty `{}` / `between:{}` can never count
 * as a bound. A scalar or list where a field-filter or range object is required,
 * an unknown field or operator, and a null or wrongly typed list member are
 * typed InvalidInput. Physical value coercion stays with the kernel composer.
 */
export const normalizeJudicialFilter = (
  spec: CollectionFilterSpec,
  raw: unknown
): Result<FilterInput, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  if (!isPlainObject(raw)) return err(invalidInput('filter must be an object', 'filter'));
  const byName = new Map(spec.fields.map((f) => [f.name, f]));
  const out: Record<string, FieldFilter> = {};
  for (const [name, value] of Object.entries(raw)) {
    const field = byName.get(name);
    if (field === undefined) return err(invalidInput('unsupported filter field', 'filter'));
    if (value === undefined || value === null) continue;
    if (!isPlainObject(value)) {
      return err(invalidInput(`${field.name} filter must be an object`, field.name));
    }
    const ff: Record<string, FilterValue> = {};
    for (const [op, operand] of Object.entries(value)) {
      if (!(field.ops as readonly string[]).includes(op)) {
        return err(invalidInput(`unsupported operator on ${field.name}`, field.name));
      }
      if (operand === undefined || operand === null) continue;
      const normalized = normalizeOperand(field, op, operand);
      if (normalized.isErr()) return err(normalized.error);
      if (normalized.value !== undefined) ff[op] = normalized.value;
    }
    if (Object.keys(ff).length > 0) out[name] = ff;
  }
  return ok(out);
};

/**
 * Validate the VIRTUAL fields of a normalized filter with the kernel TypeBox
 * deriver over the virtual-only subset of the same spec (the kernel composer
 * skips virtual fields, so nothing else would check their values): the
 * court-level enum and integer years.
 */
export const checkVirtualFields = (
  spec: CollectionFilterSpec,
  input: FilterInput
): Result<void, ApiError> => {
  const virtualFields = spec.fields.filter((f) => f.virtual === true);
  const schema = toTypeBox({ ...spec, fields: virtualFields });
  for (const field of virtualFields) {
    const value = input[field.name];
    if (value === undefined) continue;
    if (!Value.Check(schema, { [field.name]: value })) {
      return err(
        invalidInput(
          field.enumValues !== undefined
            ? `${field.name} must be one of ${field.enumValues.join(', ')}`
            : `${field.name} has an invalid value`,
          field.name
        )
      );
    }
  }
  return ok(undefined);
};

/** A validated inclusive year interval (session calendar years; never 0). */
export interface YearInterval {
  readonly from: number | null;
  readonly to: number | null;
}

const YEAR_OPERAND_MESSAGE =
  'year operands must be nonzero 32-bit integers (1 BC is -1, 2 BC is -2)';

/**
 * Intersect year operands ONCE: the lower bound is the maximum of every lower
 * operand, the upper bound the minimum of every upper operand (an `eq` is both).
 * Every operand must be an original nonzero 32-bit integer number. Returns null
 * when no operand is present. A contradictory interval (from > to) is valid and
 * matches nothing; it is never an input error.
 */
export const intersectYearOperands = (
  lower: readonly unknown[],
  upper: readonly unknown[],
  fieldName: string
): Result<YearInterval | null, ApiError> => {
  let from: number | null = null;
  let to: number | null = null;
  for (const operand of lower) {
    if (!isJudicialYearOperand(operand)) return err(invalidInput(YEAR_OPERAND_MESSAGE, fieldName));
    from = from === null ? operand : Math.max(from, operand);
  }
  for (const operand of upper) {
    if (!isJudicialYearOperand(operand)) return err(invalidInput(YEAR_OPERAND_MESSAGE, fieldName));
    to = to === null ? operand : Math.min(to, operand);
  }
  return ok(from === null && to === null ? null : { from, to });
};

/** The case-filter `year` field (normalized): eq / gte / lte / between, intersected. */
export const yearInterval = (
  ff: FieldFilter | undefined
): Result<YearInterval | null, ApiError> => {
  if (ff === undefined) return ok(null);
  const lower: unknown[] = [];
  const upper: unknown[] = [];
  if (ff['eq'] !== undefined) {
    lower.push(ff['eq']);
    upper.push(ff['eq']);
  }
  if (ff['gte'] !== undefined) lower.push(ff['gte']);
  if (ff['lte'] !== undefined) upper.push(ff['lte']);
  const between = ff['between'];
  if (between !== undefined) {
    if (!isPlainObject(between)) return err(invalidInput(YEAR_OPERAND_MESSAGE, 'year'));
    if (between.from !== undefined) lower.push(between.from);
    if (between.to !== undefined) upper.push(between.to);
  }
  return intersectYearOperands(lower, upper, 'year');
};

/**
 * Years whose January boundaries are ordinary AD dates: inside this window the
 * index-friendly native comparison `col >= make_date(y, 1, 1)` /
 * `col < make_date(y + 1, 1, 1)` is used. Outside it (BC, expanded years, the
 * timestamp-domain edges) the bound is compared with native
 * `extract(year from col)` instead, so no date is constructed past the range,
 * no year 0 is built and nothing passes through a JS Date. Both forms evaluate
 * the SESSION calendar year (date to timestamptz casts and extract both use the
 * session TimeZone).
 */
const NATIVE_BOUNDARY_YEAR_MIN = 1;
const NATIVE_BOUNDARY_YEAR_MAX = 9999;

const nativeBoundary = (year: number): boolean =>
  year >= NATIVE_BOUNDARY_YEAR_MIN && year <= NATIVE_BOUNDARY_YEAR_MAX;

/**
 * Compile a validated year interval over a timestamptz column. A finite year
 * filter requires `isfinite(col)` (infinities have no calendar year; null has
 * none either). A contradictory interval compiles to FALSE without building
 * any date. The bounds come from the ONE validated interval, never re-read.
 */
export const yearIntervalSql = (
  col: RawBuilder<unknown>,
  interval: YearInterval
): RawBuilder<SqlBool> => {
  const { from, to } = interval;
  if (from !== null && to !== null && from > to) return sql<SqlBool>`false`;
  const parts: RawBuilder<unknown>[] = [sql`isfinite(${col})`];
  if (from !== null) {
    parts.push(
      nativeBoundary(from)
        ? sql`${col} >= make_date(${from}::integer, 1, 1)`
        : sql`extract(year from ${col}) >= ${from}::integer`
    );
  }
  if (to !== null) {
    parts.push(
      nativeBoundary(to)
        ? sql`${col} < make_date(${to + 1}::integer, 1, 1)`
        : sql`extract(year from ${col}) <= ${to}::integer`
    );
  }
  return sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
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
