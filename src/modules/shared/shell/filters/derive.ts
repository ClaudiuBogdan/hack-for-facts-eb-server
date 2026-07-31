/**
 * Shared Kernel — parameterized SQL filter compilation (foundation §14.2, §15.6).
 *
 * Kysely-specific condition building belongs to the shell. Filter specs and
 * canonicalization remain pure in core.
 */

import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { andConditions, escapeLike, orConditions, safeColumnRef } from './composer.js';
import { invalidInput, type ApiError } from '../../core/errors.js';

import type { SqlCondition } from './types.js';
import type {
  CollectionFilterSpec,
  FieldFilter,
  FilterFieldSpec,
  FilterInput,
  FilterOp,
  FilterValue,
} from '../../core/filters/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Value coercion
// ─────────────────────────────────────────────────────────────────────────────

const coerceScalar = (
  field: FilterFieldSpec,
  raw: unknown
): Result<string | number | boolean, ApiError> => {
  switch (field.type) {
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n))
        return err(invalidInput(`${field.name} must be an integer`, field.name));
      return ok(n);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n))
        return err(invalidInput(`${field.name} must be a number`, field.name));
      return ok(n);
    }
    case 'money': {
      // Precision-safe: validate a decimal STRING and keep it as text (never a
      // JS float). Compiled as `::numeric` in opSql so Postgres does exact math.
      const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
      if (!/^-?\d+(\.\d+)?$/u.test(s)) {
        return err(invalidInput(`${field.name} must be a decimal string`, field.name));
      }
      return ok(s);
    }
    case 'bool':
      return ok(raw === true || raw === 'true');
    case 'enum': {
      const s = String(raw);
      if (field.enumValues !== undefined && !field.enumValues.includes(s)) {
        return err(
          invalidInput(`${field.name} must be one of ${field.enumValues.join(', ')}`, field.name)
        );
      }
      return ok(s);
    }
    case 'date':
    case 'string':
    default:
      return ok(String(raw));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Condition building
// ─────────────────────────────────────────────────────────────────────────────

/** A parameterized `array[$1, $2, …]` literal of coerced values. */
const sqlArray = (values: readonly (string | number | boolean)[]): SqlCondition =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  )}]`;

const opSql = (
  field: FilterFieldSpec,
  op: FilterOp,
  value: FilterValue,
  negate: boolean
): Result<SqlCondition | null, ApiError> => {
  if (!field.ops.includes(op)) {
    return err(invalidInput(`operator '${op}' not allowed on '${field.name}'`, field.name));
  }
  const colRef = safeColumnRef(field.column);
  const isArrayCol = field.column.arrayColumn === true;
  const isMoney = field.type === 'money';

  const wrap = (cond: SqlCondition): SqlCondition => (negate ? sql`not (${cond})` : cond);
  // Money comparisons cast both operands to numeric so Postgres does exact
  // decimal math (the bound value is a string, never a float).
  const lhs: SqlCondition = isMoney ? sql`${colRef}::numeric` : colRef;
  const rhs = (v: string | number | boolean): SqlCondition =>
    isMoney ? sql`${v}::numeric` : sql`${v}`;

  switch (op) {
    case 'isNull': {
      const want = value === true || value === 'true';
      return ok(want ? sql`${colRef} is null` : sql`${colRef} is not null`);
    }
    case 'eq': {
      const c = coerceScalar(field, value);
      if (c.isErr()) return err(c.error);
      return ok(wrap(sql`${lhs} = ${rhs(c.value)}`));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const c = coerceScalar(field, value);
      if (c.isErr()) return err(c.error);
      const sym = { gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=` }[op];
      return ok(wrap(sql`${lhs} ${sym} ${rhs(c.value)}`));
    }
    case 'between': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return err(invalidInput(`${field.name} between requires { from, to }`, field.name));
      }
      const range = value as { from?: string | number; to?: string | number };
      const parts: SqlCondition[] = [];
      if (range.from !== undefined) {
        const c = coerceScalar(field, range.from);
        if (c.isErr()) return err(c.error);
        parts.push(sql`${lhs} >= ${rhs(c.value)}`);
      }
      if (range.to !== undefined) {
        const c = coerceScalar(field, range.to);
        if (c.isErr()) return err(c.error);
        parts.push(sql`${lhs} <= ${rhs(c.value)}`);
      }
      if (parts.length === 0) return ok(null);
      return ok(wrap(andConditions(parts)));
    }
    case 'in': {
      if (!Array.isArray(value)) {
        return err(invalidInput(`${field.name} 'in' requires an array`, field.name));
      }
      // An explicit empty `in: []` means "match nothing" — compile to FALSE,
      // NOT a no-op (a dropped predicate would silently match ALL rows). #60h.
      if (value.length === 0) return ok(wrap(sql`false`));
      const coerced: (string | number | boolean)[] = [];
      for (const item of value) {
        const c = coerceScalar(field, item);
        if (c.isErr()) return err(c.error);
        coerced.push(c.value);
      }
      if (isArrayCol) {
        // membership against an array column: overlap (§15.6). text[] → `&&`;
        // jsonb array → `?|` over a text[] of the coerced values.
        const arr = sqlArray(coerced);
        const elementKey = field.column.jsonbElementKey;
        if (field.column.arrayKind === 'jsonb' && elementKey !== undefined) {
          // Objects, not scalars: `?|` tests top-level KEYS, so against
          // `[{"tag":"kind::school"}]` it asks "is there a key kind::school?" —
          // always false, no error. Unnest and read the key instead.
          return ok(
            wrap(
              sql`exists (select 1 from jsonb_array_elements(${colRef}) as _e
                    where _e ->> ${elementKey} = any(${arr}))`
            )
          );
        }
        return ok(
          wrap(
            field.column.arrayKind === 'jsonb' ? sql`${colRef} ?| ${arr}` : sql`${colRef} && ${arr}`
          )
        );
      }
      // Scalar IN — money fields cast both sides to numeric (like eq/range).
      return ok(
        wrap(
          sql`${lhs} in (${sql.join(
            coerced.map((v) => rhs(v)),
            sql`, `
          )})`
        )
      );
    }
    case 'contains': {
      if (isArrayCol) {
        // array column "contains" → @> membership (§15.6). Coerce members the
        // same as `in` (enum/type validation), then `@>` for text[] or
        // `@> to_jsonb(array[…])` for jsonb arrays.
        const items = Array.isArray(value) ? value : [value];
        const coerced: (string | number | boolean)[] = [];
        for (const item of items) {
          const c = coerceScalar(field, item);
          if (c.isErr()) return err(c.error);
          coerced.push(c.value);
        }
        const arr = sqlArray(coerced);
        const elementKey = field.column.jsonbElementKey;
        if (field.column.arrayKind === 'jsonb' && elementKey !== undefined) {
          // CONTAINS-ALL over objects. `@> to_jsonb(text[])` compares scalars to
          // objects: valid jsonb, zero rows, no error — which is how this went
          // unnoticed. Build the object form so `@>` keeps its containment
          // semantics and stays usable by a GIN index on the column.
          return ok(
            wrap(
              sql`${colRef} @> (
                select coalesce(jsonb_agg(jsonb_build_object(${elementKey}, _v)), '[]'::jsonb)
                from unnest(${arr}) as _v)`
            )
          );
        }
        return ok(
          wrap(
            field.column.arrayKind === 'jsonb'
              ? sql`${colRef} @> to_jsonb(${arr})`
              : sql`${colRef} @> ${arr}`
          )
        );
      }
      // scalar contains → trigram/ILIKE substring
      if (typeof value !== 'string') {
        return err(invalidInput(`${field.name} contains requires a string`, field.name));
      }
      const s = escapeLike(value);
      return ok(wrap(sql`${colRef} ilike ${'%' + s + '%'} escape '\\'`));
    }
    case 'prefix': {
      if (typeof value !== 'string') {
        return err(invalidInput(`${field.name} prefix requires a string`, field.name));
      }
      const s = escapeLike(value);
      return ok(wrap(sql`${colRef} ilike ${s + '%'} escape '\\'`));
    }
    default:
      return err(invalidInput(`unsupported operator '${op as string}'`, field.name));
  }
};

const buildFieldConditions = (
  field: FilterFieldSpec,
  ff: FieldFilter,
  negate: boolean
): Result<SqlCondition[], ApiError> => {
  const out: SqlCondition[] = [];
  for (const op of Object.keys(ff)) {
    const value = ff[op];
    if (value === undefined) continue;
    const built = opSql(field, op as FilterOp, value, negate);
    if (built.isErr()) return err(built.error);
    if (built.value !== null) out.push(built.value);
  }
  return ok(out);
};

/**
 * Compile a validated filter input into parameterized SQL conditions.
 * Inclusion fields AND together; `exclude` fields negate their own condition
 * (only fields with `exclude:true`). Defaults declared on the spec are applied
 * when the field is absent from the input.
 */
export const toConditionBuilders = (
  spec: CollectionFilterSpec,
  input: FilterInput
): Result<SqlCondition[], ApiError> => {
  const byName = new Map(spec.fields.map((f) => [f.name, f]));
  const conditions: SqlCondition[] = [];

  // Defaults (only when the field is absent from input). Virtual fields are
  // repo-intercepted — never compile their default to SQL (#60b).
  for (const f of spec.fields) {
    if (f.virtual === true) continue;
    if (f.default !== undefined && input[f.name] === undefined) {
      const built = opSql(f, 'eq', f.default as FilterValue, false);
      if (built.isErr()) return err(built.error);
      if (built.value !== null) conditions.push(built.value);
    }
  }

  for (const key of Object.keys(input)) {
    if (key === 'exclude') continue;
    const field = byName.get(key);
    if (field === undefined) continue;
    // Virtual fields are translated by the repo (partition/join/rollup), not
    // compiled here — a non-column virtual field would emit broken SQL (#60b).
    if (field.virtual === true) continue;
    // A composite field's keys are members, not operators: there is no column op
    // that can express it, so a non-virtual composite is a SPEC authoring bug.
    // Say that, instead of the misleading "operator 'group' not allowed".
    if (field.composite !== undefined) {
      return err(invalidInput(`composite field '${key}' must be virtual (repo-intercepted)`, key));
    }
    const ff = input[key];
    if (ff === undefined || typeof ff !== 'object') continue;
    const built = buildFieldConditions(field, ff, false);
    if (built.isErr()) return err(built.error);
    conditions.push(...built.value);
  }

  const exclude = input.exclude;
  if (exclude !== undefined) {
    const excludeConds: SqlCondition[] = [];
    for (const key of Object.keys(exclude)) {
      const field = byName.get(key);
      if (field === undefined) continue;
      if (field.virtual === true) continue;
      if (field.exclude !== true) {
        return err(invalidInput(`field '${key}' is not negatable`, key));
      }
      const ff = exclude[key];
      if (ff === undefined) continue;
      const built = buildFieldConditions(field, ff, false);
      if (built.isErr()) return err(built.error);
      excludeConds.push(...built.value);
    }
    // Negate the OR of all exclusion conditions: keep rows matching none.
    if (excludeConds.length > 0) conditions.push(sql`not ${orConditions(excludeConds)}`);
  }

  return ok(conditions);
};
