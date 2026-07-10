/**
 * Primarii-transparency repo — filter-input helpers (plan §3/§7).
 *
 * The entity spec has VIRTUAL fields the kernel composer must NOT compile:
 *   - territory (`region`/`siruta`/`isUat`/`population`) — resolved via the kernel
 *     cui→territory path, capability-gated (§13.0);
 *   - `hasIssues` (issue_count > 0);
 *   - `publishesCategory` + `categoryState` (semijoin entity_category_statuses,
 *     scoped to the CURRENT snapshot).
 * The document spec has `hasContent` (content_sha256 IS [NOT] NULL).
 *
 * They appear in the spec (so they surface in GraphQL + the fhash) but their
 * placeholder columns (`*_virtual`) are valid identifiers, so `safeColumnRef` would
 * emit bad SQL rather than fail early — hence the repo strips them before handing
 * the remainder to the composer. This mirrors the reference module's helpers.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type FieldFilter,
  type FilterInput,
  type TerritoryFilterValues,
} from '@/modules/shared/index.js';

/** Pull a single field's op-map out of a FilterInput (typed, null-safe). */
export const fieldOf = (
  input: FilterInput | null | undefined,
  name: string
): FieldFilter | undefined => {
  if (input === null || input === undefined) return undefined;
  // GraphQL nullable input fields can be null at runtime even though FilterInput's
  // compile-time shape omits null, so deliberately widen before validating.
  const v: unknown = input[name];
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as FieldFilter;
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
  const exclude: unknown = input.exclude;
  if (
    exclude !== null &&
    exclude !== undefined &&
    typeof exclude === 'object' &&
    !Array.isArray(exclude)
  ) {
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
 * values under `exclude` (negation).
 */
export interface VirtualValues {
  /** Undefined means the field is absent; an empty array means match nothing. */
  readonly include: readonly string[] | undefined;
  /** Undefined means absent; an empty array is the no-op `NOT FALSE`. */
  readonly exclude: readonly string[] | undefined;
}

/**
 * Resolve `eq` and `in` using the kernel's within-field AND semantics:
 * `eq:x AND in:[x,y]` narrows to x, while `eq:x AND in:[y]` matches nothing.
 */
const selectedValues = (f: FieldFilter | undefined): readonly string[] | undefined => {
  if (f === undefined) return undefined;
  const eq = eqValue(f);
  const inList = inValues(f);
  if (eq !== undefined && inList !== undefined) return inList.includes(eq) ? [eq] : [];
  if (inList !== undefined) return [...new Set(inList)];
  return eq !== undefined ? [eq] : undefined;
};

export const virtualValues = (input: FilterInput, name: string): VirtualValues => {
  const include = selectedValues(fieldOf(input, name));

  const excludeBranch = input.exclude;
  const exclude = selectedValues(fieldOf(excludeBranch, name));
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
  const operands = (f: FieldFilter | undefined): readonly string[] => {
    const eq = eqValue(f);
    return [...(eq !== undefined ? [eq] : []), ...(inValues(f) ?? [])];
  };
  const values = [...operands(fieldOf(input, name)), ...operands(fieldOf(input.exclude, name))];
  for (const v of values) {
    if (!allowed.includes(v)) {
      return err(invalidInput(`${name} must be one of ${allowed.join(', ')}`, name));
    }
  }
  return ok(undefined);
};

/** Read a finite `between.{from,to}` numeric bound off a field op-map. */
const betweenBounds = (
  f: FieldFilter | undefined,
  name: string
): Result<{ min?: number; max?: number }, ApiError> => {
  if (f === undefined) return ok({});
  // Widen for nullable GraphQL runtime input; malformed null returns InvalidInput.
  const between: unknown = f['between'];
  if (between === undefined) return ok({});
  if (between === null || typeof between !== 'object' || Array.isArray(between)) {
    return err(invalidInput(`${name} between requires { from, to }`, name));
  }
  const { from, to } = between as { from?: string | number; to?: string | number };
  const out: { min?: number; max?: number } = {};
  if (from !== undefined) {
    const n = Number(from);
    if (!Number.isFinite(n))
      return err(invalidInput(`${name} between.from must be a number`, name));
    out.min = n;
  }
  if (to !== undefined) {
    const n = Number(to);
    if (!Number.isFinite(n)) return err(invalidInput(`${name} between.to must be a number`, name));
    out.max = n;
  }
  return ok(out);
};

/**
 * Project the primarii entity FilterInput's geographic fields onto the kernel
 * `TerritoryFilterValues` shape: `region`/`siruta` (eq/in + exclude), `isUat`
 * (bool eq), `population` (between → min/max). The kernel
 * `buildTerritoryCuiPredicate` turns this into the cui→territory semijoin.
 * Validates the population range; the kernel builder owns the SQL.
 */
export const territoryFilterValues = (
  input: FilterInput
): Result<TerritoryFilterValues, ApiError> => {
  const region = virtualValues(input, 'region');
  const siruta = virtualValues(input, 'siruta');
  const isUat = boolEq(fieldOf(input, 'isUat'));
  const popBounds = betweenBounds(fieldOf(input, 'population'), 'population');
  if (popBounds.isErr()) return err(popBounds.error);

  const values: TerritoryFilterValues = {
    ...(region.include !== undefined && { region: region.include }),
    ...(region.exclude !== undefined &&
      region.exclude.length > 0 && { excludeRegion: region.exclude }),
    ...(siruta.include !== undefined && { siruta: siruta.include }),
    ...(siruta.exclude !== undefined &&
      siruta.exclude.length > 0 && { excludeSiruta: siruta.exclude }),
    ...(isUat !== undefined && { isUat }),
    ...(popBounds.value.min !== undefined && { populationMin: popBounds.value.min }),
    ...(popBounds.value.max !== undefined && { populationMax: popBounds.value.max }),
  };
  return ok(values);
};
