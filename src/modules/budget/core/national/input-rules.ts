/**
 * National budget — small strict validators shared by the seven root inputs.
 *
 * Inputs come from GraphQL (already coerced, `null` for explicit nulls) or MCP
 * (decoded JSON). Both are treated as `unknown`. Absent and `null` mean
 * "omitted"; an explicit empty list is refused; unknown keys and duplicate list
 * members are refused. Set-like lists are returned in canonical order so equal
 * requests have equal canonical forms (cursor filter hash, cache key).
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { isOneOf } from './vocabulary.js';

export type Check<T> = (value: unknown, field: string) => Result<T, ApiError>;

export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

/** An input object with only the given keys. */
export const objectWithKeys = (
  value: unknown,
  field: string,
  keys: readonly string[]
): Result<Record<string, unknown>, ApiError> => {
  if (!isRecord(value)) return err(invalidInput(`${field} must be an object`, field));
  const unknownKey = Object.keys(value).find((key) => !keys.includes(key));
  return unknownKey === undefined
    ? ok(value)
    : err(
        invalidInput(`${field}.${unknownKey} is not a supported field`, `${field}.${unknownKey}`)
      );
};

/**
 * The one member of an `@oneOf` input, with GraphQL coercion parity: every
 * supplied key counts, including an explicit `null` (only `undefined` is
 * "not supplied"), exactly one key must be supplied, and its value must be
 * non-null. Ordinary optional fields elsewhere still treat `null` as omitted.
 */
export const oneOfMember = <K extends string>(
  value: unknown,
  field: string,
  keys: readonly K[]
): Result<{ readonly key: K; readonly value: unknown }, ApiError> => {
  const record = objectWithKeys(value, field, keys);
  if (record.isErr()) return err(record.error);
  const supplied = keys.filter((key) => record.value[key] !== undefined);
  const [key] = supplied;
  if (supplied.length !== 1 || key === undefined) {
    return err(invalidInput(`${field} requires exactly one of ${keys.join(', ')}`, field));
  }
  const member = record.value[key];
  if (member === null) {
    return err(invalidInput(`${field}.${key} must not be null`, `${field}.${key}`));
  }
  return ok({ key, value: member });
};

export const enumValue =
  <T extends string>(values: readonly T[]): Check<T> =>
  (value, field) =>
    isOneOf(values, value)
      ? ok(value)
      : err(invalidInput(`${field} must be one of ${values.join(', ')}`, field));

export const yearValue: Check<number> = (value, field) =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR
    ? ok(value)
    : err(
        invalidInput(
          `${field} must be an integer year ${String(MIN_YEAR)}–${String(MAX_YEAR)}`,
          field
        )
      );

/** Integer within bounds; absent/null gives the documented SDL default. */
export const boundedInt = (
  value: unknown,
  field: string,
  bounds: { readonly min: number; readonly max: number; readonly fallback: number }
): Result<number, ApiError> => {
  if (!isPresent(value)) return ok(bounds.fallback);
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
    ? ok(value)
    : err(
        invalidInput(
          `${field} must be an integer ${String(bounds.min)}–${String(bounds.max)}`,
          field
        )
      );
};

/** Opaque or printed text: non-empty, bounded, no surrounding whitespace. */
export const textValue =
  (maxLength: number, pattern?: RegExp): Check<string> =>
  (value, field) => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maxLength ||
      value.trim() !== value
    ) {
      return err(
        invalidInput(
          `${field} must be non-empty text of at most ${String(maxLength)} characters without surrounding spaces`,
          field
        )
      );
    }
    return pattern === undefined || pattern.test(value)
      ? ok(value)
      : err(invalidInput(`${field} has an invalid format`, field));
  };

/** Printed authority code: 1–8 ASCII letters or digits. */
export const authorityCodeValue = textValue(8, /^[A-Za-z0-9]{1,8}$/u);

/** Printed classification code (capitol), compared to trimmed source codes. */
export const codeValue = textValue(16);

/** Opaque identifier (interpretation, item); any existing ID text. */
export const idValue = textValue(200);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Canonical (lowercase, hyphenated) UUID text, as PostgreSQL prints a `uuid`. */
export const isCanonicalUuid = (value: string): boolean => UUID.test(value);

/**
 * A selection ID input (`uuid` column): hyphenated hex in either case,
 * canonicalised to lowercase so filters, duplicates and pins agree.
 */
export const uuidValue: Check<string> = (value, field) => {
  const canonical = typeof value === 'string' ? value.toLowerCase() : '';
  return isCanonicalUuid(canonical)
    ? ok(canonical)
    : err(invalidInput(`${field} must be a UUID`, field));
};

export interface EditionKey {
  readonly id: string;
  readonly budgetYear: number;
}

/**
 * Edition ID `<budgetYear>:<publication>`, the identity this API serves in its
 * catalog. The budget year is read from the ID so per-year rules can be
 * checked before any read; whether the edition is loaded is a catalog fact.
 */
const EDITION_ID = /^(\d{4}):([A-Za-z0-9_.-]{1,100})$/u;

export const editionIdValue: Check<EditionKey> = (value, field) => {
  const match = typeof value === 'string' ? EDITION_ID.exec(value) : null;
  const year = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  if (typeof value !== 'string' || match === null || year < MIN_YEAR || year > MAX_YEAR) {
    return err(invalidInput(`${field} must be an edition ID <budgetYear>:<publication>`, field));
  }
  return ok({ id: value, budgetYear: year });
};

export interface ListRules<T> {
  readonly max: number;
  readonly item: Check<T>;
  /** Canonical comparison key; lists are returned sorted by it. Omit to keep order. */
  readonly sortKey?: (item: T) => string | number;
  /** Uniqueness key (defaults to the sort key, then the item itself). */
  readonly identity?: (item: T) => string | number;
}

const compareKeys = (a: string | number, b: string | number): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

/** Optional list: absent/null → null (the documented default); empty → refused. */
export const optionalList = <T>(
  value: unknown,
  field: string,
  rules: ListRules<T>
): Result<readonly T[] | null, ApiError> => {
  if (!isPresent(value)) return ok(null);
  return requiredList(value, field, rules);
};

/** Required non-empty list with bounded size and unique members. */
export const requiredList = <T>(
  value: unknown,
  field: string,
  rules: ListRules<T>
): Result<readonly T[], ApiError> => {
  if (value === undefined || value === null) {
    return err(invalidInput(`${field} must be a list`, field));
  }
  // GraphQL list input coercion, applied identically for MCP: a single value
  // stands for a one-element list.
  const raw: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  if (raw.length === 0) return err(invalidInput(`${field} must not be empty`, field));
  if (raw.length > rules.max) {
    return err(invalidInput(`${field} allows at most ${String(rules.max)} entries`, field));
  }
  const items: T[] = [];
  const seen = new Set<string | number>();
  for (const [index, entry] of raw.entries()) {
    const checked = rules.item(entry, `${field}[${String(index)}]`);
    if (checked.isErr()) return err(checked.error);
    const identity =
      rules.identity?.(checked.value) ??
      rules.sortKey?.(checked.value) ??
      (checked.value as string | number);
    if (seen.has(identity)) return err(invalidInput(`${field} contains duplicates`, field));
    seen.add(identity);
    items.push(checked.value);
  }
  const sortKey = rules.sortKey;
  return ok(
    sortKey === undefined ? items : [...items].sort((a, b) => compareKeys(sortKey(a), sortKey(b)))
  );
};

/** Sort key placing closed-vocabulary values in their declared order. */
export const declaredOrder =
  <T extends string>(values: readonly T[]) =>
  (item: T): number =>
    values.indexOf(item);
