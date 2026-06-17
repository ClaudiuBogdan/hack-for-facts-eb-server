/**
 * Reference repo — filter-input helpers (plan §3/§7).
 *
 * The reference module has VIRTUAL filter fields (no compilable physical column):
 *   - public_entity: `countyCode`/`region` (join core.territories), `parentCui`
 *     (parent1_cui OR parent2_cui), `hasIssues` (jsonb_array_length>0);
 *   - territory: `isUat` (uat_code IS NOT NULL).
 * They appear in the spec (so they surface in GraphQL/TypeBox + the fhash) but the
 * kernel composer must NOT compile them — their placeholder columns (e.g.
 * `county_code_virtual`) are valid identifiers, so `safeColumnRef` would emit bad
 * SQL rather than fail early (review BLOCKER). This helper strips them from BOTH the
 * top-level fields AND the `exclude.*` branch (the exclude branch is compiled
 * separately by the kernel) before the repo hands the remainder to the composer.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError, type FieldFilter, type FilterInput } from '@/modules/shared/index.js';

/** Pull a single field's op-map out of a FilterInput (typed, undefined-safe). */
export const fieldOf = (input: FilterInput, name: string): FieldFilter | undefined => {
  const v = input[name];
  if (v === undefined || typeof v !== 'object') return undefined;
  return v;
};

/**
 * Remove the named virtual fields from a FilterInput — top-level AND under
 * `exclude` — so the kernel composer never sees a virtual column. Returns a new
 * object (does not mutate the input).
 */
export const omitVirtualFields = (input: FilterInput, names: readonly string[]): FilterInput => {
  const drop = new Set(names);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'exclude') continue;
    if (!drop.has(key)) out[key] = value;
  }
  const exclude = input.exclude;
  if (exclude !== undefined && typeof exclude === 'object') {
    const ex: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(exclude)) {
      if (!drop.has(key)) ex[key] = value;
    }
    if (Object.keys(ex).length > 0) out['exclude'] = ex;
  }
  return out as FilterInput;
};

/** Read a scalar `eq` value off a field op-map (string|number → string). */
export const eqValue = (f: FieldFilter | undefined): string | undefined => {
  if (f === undefined) return undefined;
  const v = f['eq'];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
};

/** Read an `in` array off a field op-map (→ string[]). */
export const inValues = (f: FieldFilter | undefined): readonly string[] | undefined => {
  if (f === undefined) return undefined;
  const v = f['in'];
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x));
};

/** Read a bool `eq` off a field op-map. */
export const boolEq = (f: FieldFilter | undefined): boolean | undefined => {
  if (f === undefined) return undefined;
  const v = f['eq'];
  if (v === undefined) return undefined;
  return v === true || v === 'true';
};

/**
 * Collect the eq + in values (inclusion) for a virtual field, plus the eq + in
 * values under `exclude` (negation) — so the repo can build matching/negated
 * EXISTS or join predicates for `countyCode`/`region`.
 */
export interface VirtualValues {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export const virtualValues = (input: FilterInput, name: string): VirtualValues => {
  const inc = fieldOf(input, name);
  const incEq = eqValue(inc);
  const incIn = inValues(inc);
  const include = incIn ?? (incEq !== undefined ? [incEq] : []);

  const excludeBranch = input.exclude;
  let exclude: readonly string[] = [];
  if (excludeBranch !== undefined && typeof excludeBranch === 'object') {
    const ex = fieldOf(excludeBranch, name);
    const exEq = eqValue(ex);
    const exIn = inValues(ex);
    exclude = exIn ?? (exEq !== undefined ? [exEq] : []);
  }
  return { include, exclude };
};

/**
 * Validate the VIRTUAL enum fields the repo intercepts (the kernel composer never
 * validates them, since they are stripped). A malformed value would otherwise
 * silently no-op. Checks both inclusion and exclusion branches.
 */
export const validateVirtualEnum = (
  input: FilterInput,
  name: string,
  allowed: readonly string[]
): Result<void, ApiError> => {
  const { include, exclude } = virtualValues(input, name);
  for (const v of [...include, ...exclude]) {
    if (!allowed.includes(v)) {
      return err(invalidInput(`${name} must be one of ${allowed.join(', ')}`, name));
    }
  }
  return ok(undefined);
};
