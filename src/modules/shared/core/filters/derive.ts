/**
 * Shared Kernel — Filter derivers (foundation §14.2, §14.3, §15.6).
 *
 *  - `canonicalizeFilters(spec, input)` → stable string: defaults filled,
 *     fields/ops sorted, arrays sorted, strings lowercased. Backs the cache key,
 *     the cursor `fhash`, and the tri-surface equivalence test.
 *  - `filterHash(...)` → short stable hash of the canonical string (the `fhash`).
 *  - `toConditionBuilders(spec, input)` → parameterized `SqlCondition[]` for the
 *     composer. Array columns compile to membership (`@>`/overlap), scalars to
 *     `=`/range/`ILIKE` (§15.6). Negation only for `exclude:true` fields.
 *
 * All value coercion validates against the field spec; unknown fields/ops are
 * ignored rather than trusted, and malformed values yield an `InvalidInput`.
 */

import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '../errors.js';
import { andConditions, escapeLike, orConditions, safeColumnRef } from './composer.js';

import type {
  CollectionFilterSpec,
  FieldFilter,
  FilterFieldSpec,
  FilterInput,
  FilterOp,
  FilterValue,
  SqlCondition,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a scalar to its canonical form by FIELD TYPE so the three surfaces
 * agree: REST `"2024"` and GraphQL `2024` both fold to the number `2024`;
 * strings lowercase. This is what makes the fhash identical cross-surface.
 */
const canonScalar = (type: FilterFieldSpec['type'], x: unknown): unknown => {
  if (type === 'int' || type === 'number') {
    const n = typeof x === 'number' ? x : Number(x);
    return Number.isFinite(n) ? n : x;
  }
  if (type === 'money') {
    // Normalize the decimal so "100", "100.00" and 100 hash identically
    // (numerically equal). Keep as a STRING (no float) to preserve precision.
    const s = typeof x === 'number' ? String(x) : typeof x === 'string' ? x.trim() : '';
    if (!/^-?\d+(\.\d+)?$/u.test(s)) return x;
    const neg = s.startsWith('-');
    const [intPart = '0', fracRaw = ''] = s.replace(/^-/u, '').split('.');
    const frac = fracRaw.replace(/0+$/u, '');
    const intNorm = intPart.replace(/^0+(?=\d)/u, '');
    const body = frac.length > 0 ? `${intNorm}.${frac}` : intNorm;
    return `${neg && body !== '0' ? '-' : ''}${body}`;
  }
  if (type === 'bool') return x === true || x === 'true';
  if (typeof x === 'string') return x.toLowerCase();
  return x;
};

const toSortKey = (x: unknown): string =>
  typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x) : '';

const canonValue = (type: FilterFieldSpec['type'], v: FilterValue): unknown => {
  if (Array.isArray(v)) {
    const items: unknown[] = (v as readonly (string | number)[]).map((x) => canonScalar(type, x));
    return items.sort((a, b) => toSortKey(a).localeCompare(toSortKey(b)));
  }
  if (typeof v === 'object') {
    const o = v as { from?: unknown; to?: unknown };
    return {
      from: o.from === undefined ? null : canonScalar(type, o.from),
      to: o.to === undefined ? null : canonScalar(type, o.to),
    };
  }
  return canonScalar(type, v);
};

const canonFieldFilter = (field: FilterFieldSpec, ff: FieldFilter): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const op of Object.keys(ff).sort()) {
    const value = ff[op];
    if (value !== undefined) out[op] = canonValue(field.type, value);
  }
  return out;
};

/**
 * Produce a stable canonical JSON string for an input against a spec. Defaults
 * declared on the spec are filled so that an omitted-vs-default input hashes
 * identically across the three surfaces.
 */
export const canonicalizeFilters = (spec: CollectionFilterSpec, input: FilterInput): string => {
  const byName = new Map(spec.fields.map((f) => [f.name, f]));
  const canon: { fields: Record<string, unknown>; exclude: Record<string, unknown> } = {
    fields: {},
    exclude: {},
  };

  // Fill defaults first.
  for (const f of spec.fields) {
    if (f.default !== undefined) {
      canon.fields[f.name] = { eq: canonValue(f.type, f.default as FilterValue) };
    }
  }

  for (const key of Object.keys(input)) {
    if (key === 'exclude') continue;
    const f = byName.get(key);
    if (f === undefined) continue;
    const ff = input[key];
    if (ff === undefined || typeof ff !== 'object') continue;
    const canonized = canonFieldFilter(f, ff);
    // An explicit empty `{ field: {} }` must not blow away a declared default.
    if (Object.keys(canonized).length > 0) canon.fields[key] = canonized;
  }

  const exclude = input.exclude;
  if (exclude !== undefined) {
    for (const key of Object.keys(exclude)) {
      const f = byName.get(key);
      const ff = exclude[key];
      if (f?.exclude === true && ff !== undefined) {
        canon.exclude[key] = canonFieldFilter(f, ff);
      }
    }
  }

  // Sort top-level keys for stability.
  const sortedFields = Object.fromEntries(Object.entries(canon.fields).sort());
  const sortedExclude = Object.fromEntries(Object.entries(canon.exclude).sort());
  return JSON.stringify({ c: spec.collection, fields: sortedFields, exclude: sortedExclude });
};

/**
 * A stable, non-cryptographic 64-bit FNV-1a hash of the canonical string,
 * rendered base36. 64 bits gives collision resistance commensurate with the
 * data volume so a deliberately-crafted different filter set cannot share an
 * fhash (the cursor only controls pagination, but we still reject mismatches).
 */
export const filterHash = (canonical: string): string => {
  // Two interleaved 32-bit FNV-1a lanes → an effective 64-bit digest.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x1234567;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c + i) & 0xff), 0x01000193);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};

/** Convenience: canonicalize + hash in one call (the cursor `fhash`). */
export const fhashFor = (spec: CollectionFilterSpec, input: FilterInput): string =>
  filterHash(canonicalizeFilters(spec, input));

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
      if (!Number.isInteger(n)) return err(invalidInput(`${field.name} must be an integer`, field.name));
      return ok(n);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return err(invalidInput(`${field.name} must be a number`, field.name));
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
        return err(invalidInput(`${field.name} must be one of ${field.enumValues.join(', ')}`, field.name));
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
  sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]`;

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
      if (value.length === 0) return ok(null);
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
        return ok(
          wrap(
            field.column.arrayKind === 'jsonb'
              ? sql`${colRef} ?| ${arr}`
              : sql`${colRef} && ${arr}`
          )
        );
      }
      // Scalar IN — money fields cast both sides to numeric (like eq/range).
      return ok(wrap(sql`${lhs} in (${sql.join(coerced.map((v) => rhs(v)), sql`, `)})`));
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

  // Defaults (only when the field is absent from input).
  for (const f of spec.fields) {
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
