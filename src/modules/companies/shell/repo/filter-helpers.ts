/**
 * Companies repo — filter-input helpers (plan §3/§7).
 *
 * `caenCode`, `county`, and `hasFinancials` are VIRTUAL filter fields: they appear
 * in the spec (so they surface in GraphQL + the fhash) but the kernel composer must
 * NOT compile them — `caenCode`/`hasFinancials` become EXISTS subqueries and
 * `county` becomes a diacritic-folded match (NO `unaccent()`; the extension is not
 * installed — §13-R4). This helper splits a `FilterInput` and validates the
 * virtual fields the composer never sees.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError, type FieldFilter, type FilterInput } from '@/modules/shared/index.js';

import { COMPANY_VIRTUAL_FIELDS } from '../../core/filters.js';


export const fieldOf = (input: FilterInput, name: string): FieldFilter | undefined => {
  const v = input[name];
  if (v === undefined || typeof v !== 'object') return undefined;
  return v;
};

/** Remove the named (virtual) fields so the kernel composer skips them. */
export const omitFields = (input: FilterInput, names: readonly string[]): FilterInput => {
  const drop = new Set(names);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'exclude') {
      // Strip virtual fields from the exclude sub-object too.
      if (value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
        const ex: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!drop.has(k)) ex[k] = v;
        }
        if (Object.keys(ex).length > 0) out['exclude'] = ex;
      }
      continue;
    }
    if (!drop.has(key)) out[key] = value;
  }
  return out as FilterInput;
};

/** Split a FilterInput into the composer-safe part and the virtual fields. */
export const splitVirtual = (input: FilterInput): { physical: FilterInput; virtual: FilterInput } => {
  const virtual: Record<string, unknown> = {};
  for (const name of COMPANY_VIRTUAL_FIELDS) {
    const f = input[name];
    if (f !== undefined) virtual[name] = f;
  }
  return { physical: omitFields(input, COMPANY_VIRTUAL_FIELDS), virtual: virtual as FilterInput };
};

/** True if a field's op-map will PRODUCE a predicate (rejects empty in/between). */
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
    return true;
  }
  return false;
};

/** Pull string `eq`/`in` values for a (virtual) field. */
export const stringValues = (f: FieldFilter | undefined): { eq?: string; in?: readonly string[]; prefix?: string } => {
  if (f === undefined) return {};
  const out: { eq?: string; in?: readonly string[]; prefix?: string } = {};
  const eq = f['eq'];
  if (typeof eq === 'string' || typeof eq === 'number') out.eq = String(eq);
  const inV = f['in'];
  if (Array.isArray(inV)) out.in = inV.map((x) => String(x));
  const pre = f['prefix'];
  if (typeof pre === 'string') out.prefix = pre;
  return out;
};

export const boolEq = (f: FieldFilter | undefined): boolean | undefined => {
  if (f === undefined) return undefined;
  const v = f['eq'];
  if (v === undefined) return undefined;
  return v === true || v === 'true';
};

export const isNullValue = (f: FieldFilter | undefined): boolean | undefined => {
  if (f === undefined) return undefined;
  const v = f['isNull'];
  if (v === undefined) return undefined;
  return v === true || v === 'true';
};

/** Enforce the aggregate driving-predicate rule (groupBy=county has no raw_county index). */
export const requireAggregateDriver = (
  input: FilterInput,
  drivingFields: readonly string[],
  hint: string
): Result<void, ApiError> => {
  const present = drivingFields.some((name) => hasField(input, name));
  if (!present) return err(invalidInput(`aggregate needs at least one of ${hint}`, 'filter'));
  return ok(undefined);
};
