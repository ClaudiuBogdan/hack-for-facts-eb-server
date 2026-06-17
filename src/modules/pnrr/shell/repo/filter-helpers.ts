/**
 * PNRR repo — filter-input helpers (plan §3/§7).
 *
 * Some PNRR filter fields are VIRTUAL (no physical column): `role`/`hub`/
 * `hasNoHub` on entities resolve to is_* flags or EXISTS subqueries, and `year`
 * on payments compiles to a `payment_date` range. These appear in the spec (so
 * they surface in GraphQL/TypeBox and the fhash) but the kernel composer must NOT
 * compile them — the repo intercepts them. This helper splits a `FilterInput`
 * into the intercepted virtual fields and the remainder the kernel composer
 * handles, and enforces the index-bound driving-predicate rule.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError, type FieldFilter, type FilterInput } from '@/modules/shared/index.js';

/** Pull a single field's op-map out of a FilterInput (typed, undefined-safe). */
export const fieldOf = (input: FilterInput, name: string): FieldFilter | undefined => {
  const v = input[name];
  if (v === undefined || typeof v !== 'object') return undefined;
  return v;
};

/** Remove the named virtual fields from a FilterInput (so the composer skips them). */
export const omitFields = (input: FilterInput, names: readonly string[]): FilterInput => {
  const drop = new Set(names);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out as FilterInput;
};

/**
 * True if the input carries an op-map for `name` that will PRODUCE a SQL
 * predicate — i.e. at least one op with a meaningful value. Critically this
 * rejects `{ in: [] }` and `{ between: {} }`, which the kernel composer drops to
 * NO condition; without this check an empty `in` would pass the driving-predicate
 * guard yet emit no bound, turning into an unbounded scan (review finding).
 */
export const hasField = (input: FilterInput, name: string): boolean => {
  const f = fieldOf(input, name);
  if (f === undefined) return false;
  for (const op of Object.keys(f)) {
    const value: unknown = f[op];
    if (value === undefined) continue;
    if (op === 'in') {
      if (Array.isArray(value) && value.length > 0) return true;
      continue;
    }
    if (op === 'between') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const r = value as { from?: unknown; to?: unknown };
        if (r.from !== undefined || r.to !== undefined) return true;
      }
      continue;
    }
    // eq/gt/.../prefix/contains/isNull all produce a predicate when present.
    return true;
  }
  return false;
};

/**
 * Enforce the index-bound rule: at least one of the driving predicates must be
 * present (an indexed column). Returns InvalidInput naming the accepted set.
 */
export const requireDrivingPredicate = (
  input: FilterInput,
  drivingFields: readonly string[],
  hint: string
): Result<void, ApiError> => {
  const present = drivingFields.some((name) => hasField(input, name));
  if (!present) return err(invalidInput(`needs at least one of ${hint}`, 'filter'));
  return ok(undefined);
};

/** Coerce a scalar eq value out of a field's op-map (for virtual-field handling). */
export const eqValue = (f: FieldFilter | undefined): string | undefined => {
  if (f === undefined) return undefined;
  const v = f['eq'];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
};

/** Coerce an `in` array value out of a field's op-map. */
export const inValues = (f: FieldFilter | undefined): readonly string[] | undefined => {
  if (f === undefined) return undefined;
  const v = f['in'];
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x));
};

/** Read a bool eq off a field op-map. */
export const boolEq = (f: FieldFilter | undefined): boolean | undefined => {
  if (f === undefined) return undefined;
  const v = f['eq'];
  if (v === undefined) return undefined;
  return v === true || v === 'true';
};

/** Read an int eq off a field op-map. */
export const intEq = (f: FieldFilter | undefined): number | undefined => {
  const v = eqValue(f);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

/**
 * Validate the VIRTUAL filter fields (intercepted by the repo, so the kernel
 * composer never validates them). A malformed virtual value would otherwise
 * silently no-op AND still satisfy the driving-predicate guard. Returns the first
 * `InvalidInput`, or ok.
 */
export const validateVirtualFilters = (input: FilterInput): Result<void, ApiError> => {
  const enumEq = (name: string, allowed: readonly string[]): Result<void, ApiError> => {
    const f = fieldOf(input, name);
    if (f === undefined) return ok(undefined);
    const eq = eqValue(f);
    if (eq !== undefined && !allowed.includes(eq)) {
      return err(invalidInput(`${name} must be one of ${allowed.join(', ')}`, name));
    }
    const arr = inValues(f);
    if (arr?.some((v) => !allowed.includes(v)) === true) {
      return err(invalidInput(`${name} must be one of ${allowed.join(', ')}`, name));
    }
    return ok(undefined);
  };

  const role = enumEq('role', ['beneficiary', 'applicant', 'winner', 'subcontractor']);
  if (role.isErr()) return role;
  const hub = enumEq('hub', ['public_entities', 'companies']);
  if (hub.isErr()) return hub;

  const hasNoHubF = fieldOf(input, 'hasNoHub');
  if (hasNoHubF?.['eq'] !== undefined) {
    const v = hasNoHubF['eq'];
    if (v !== true && v !== false && v !== 'true' && v !== 'false') {
      return err(invalidInput('hasNoHub must be a boolean', 'hasNoHub'));
    }
  }

  const yearF = fieldOf(input, 'year');
  if (yearF?.['eq'] !== undefined) {
    const n = intEq(yearF);
    if (n === undefined || n < 2000 || n > 2100) {
      return err(invalidInput('year must be an integer between 2000 and 2100', 'year'));
    }
  }
  return ok(undefined);
};
