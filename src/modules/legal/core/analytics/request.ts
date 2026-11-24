/**
 * Legislation analytics: one validation for every surface. The raw arguments
 * are checked against the view's own argument list (an argument another view
 * takes is refused, never ignored) and against the PINNED layer's value lists,
 * then reduced to canonical form: lists sorted and distinct, defaults dropped,
 * keys in a fixed order. The canonical form is the cache key's argument part,
 * so equal questions share one cache entry and the key space stays bounded by
 * the layer's own values.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import {
  LEGAL_ANALYTICS_LENSES,
  LEGAL_ANALYTICS_ORDERS,
  LEGAL_ANALYTICS_POPULATIONS,
  LEGAL_ANALYTICS_VIEWS,
  UNCERTAIN,
  type LegalAnalyticsActsCursor,
  type LegalAnalyticsArgs,
  type LegalAnalyticsFilter,
  type LegalAnalyticsHead,
  type LegalAnalyticsLens,
  type LegalAnalyticsRequest,
  type LegalAnalyticsView,
} from './types.js';

export const YEAR_MIN = 1800;
export const YEAR_MAX = 2100;
export const BREAKDOWN_LIMIT = { default: 30, max: 1000 } as const;
export const SERIES_TOP = { default: 5, max: 10 } as const;
export const ACTS_LIMIT = { default: 25, max: 50 } as const;
const MAX_TYPES = 25;
const MAX_TEXT = 200;

const FILTER_KEYS = [
  'population',
  'from',
  'to',
  'type',
  'issuer',
  'family',
  'felul',
  'versions',
] as const satisfies readonly (keyof LegalAnalyticsArgs)[];

/** The arguments each view takes; any other is refused. */
export const VIEW_ARGS: Readonly<
  Record<LegalAnalyticsView, readonly (keyof LegalAnalyticsArgs)[]>
> = {
  head: [],
  summary: FILTER_KEYS,
  breakdown: [...FILTER_KEYS, 'lens', 'limit'],
  series: [...FILTER_KEYS, 'lens', 'top'],
  grid: [...FILTER_KEYS, 'lens', 'by'],
  links: FILTER_KEYS,
  acts: [...FILTER_KEYS, 'order', 'limit', 'cursor'],
};

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

export const isLegalAnalyticsView = (value: string): value is LegalAnalyticsView =>
  isOneOf(LEGAL_ANALYTICS_VIEWS, value);

const intIn = (
  field: string,
  value: number | undefined,
  min: number,
  max: number
): Result<number | null, ApiError> => {
  if (value === undefined) return ok(null);
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? ok(value)
    : err(invalidInput(`${field} must be an integer from ${String(min)} to ${String(max)}`, field));
};

const text = (field: string, value: string | undefined): Result<string | null, ApiError> => {
  if (value === undefined) return ok(null);
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= MAX_TEXT
    ? ok(trimmed)
    : err(
        invalidInput(
          `${field} must be a non-empty text of at most ${String(MAX_TEXT)} characters`,
          field
        )
      );
};

/** Every value a `felul` filter may name: the layer's groups and kinds, and `uncertain`. */
export const felulValues = (head: LegalAnalyticsHead): ReadonlySet<string> =>
  new Set([...head.values.felulGroups, ...Object.keys(head.values.felulKinds), UNCERTAIN]);

const parseFilter = (
  args: LegalAnalyticsArgs,
  head: LegalAnalyticsHead
): Result<LegalAnalyticsFilter, ApiError> => {
  const population = args.population ?? 'flow';
  if (!isOneOf(LEGAL_ANALYTICS_POPULATIONS, population))
    return err(invalidInput('population must be flow or stock', 'population'));
  const from = intIn('from', args.from, YEAR_MIN, YEAR_MAX);
  if (from.isErr()) return err(from.error);
  const to = intIn('to', args.to, YEAR_MIN, YEAR_MAX);
  if (to.isErr()) return err(to.error);
  if (from.value !== null && to.value !== null && from.value > to.value)
    return err(invalidInput('from must not be after to', 'from'));

  const knownTypes = new Set(head.types.map((t) => t.key));
  // the raw list is bounded before de-duplication, on every surface
  if ((args.type ?? []).length > MAX_TYPES)
    return err(invalidInput(`at most ${String(MAX_TYPES)} types`, 'type'));
  const types = [...new Set((args.type ?? []).map((t) => t.trim()))].sort();
  if (types.some((t) => !knownTypes.has(t)))
    return err(invalidInput('type names a type the layer does not hold', 'type'));

  // a lineage the layer knows passes whatever its length (joint orders keep long raw names)
  const known = args.issuer !== undefined && head.issuers.some((i) => i.lineage === args.issuer);
  const issuer = known ? ok(args.issuer ?? null) : text('issuer', args.issuer);
  if (issuer.isErr()) return err(issuer.error);
  if (issuer.value !== null && !known)
    return err(invalidInput('issuer names no issuer lineage of the layer', 'issuer'));
  const family = text('family', args.family);
  if (family.isErr()) return err(family.error);
  if (family.value !== null && !head.values.issuerFamilies.includes(family.value))
    return err(invalidInput('family names no issuer family of the layer', 'family'));
  const felul = text('felul', args.felul);
  if (felul.isErr()) return err(felul.error);
  if (felul.value !== null && !felulValues(head).has(felul.value))
    return err(invalidInput('felul names no Felul group, kind or class of the layer', 'felul'));
  const versions = intIn('versions', args.versions, 0, 3);
  if (versions.isErr()) return err(versions.error);

  return ok({
    population: population,
    from: from.value,
    to: to.value,
    types,
    issuer: issuer.value,
    family: family.value,
    felul: felul.value,
    versions: versions.value,
  });
};

/** The filter's canonical arguments: defaults dropped, keys in FILTER_KEYS order. */
export const canonicalFilter = (f: LegalAnalyticsFilter): Record<string, unknown> => ({
  ...(f.population !== 'flow' && { population: f.population }),
  ...(f.from !== null && { from: f.from }),
  ...(f.to !== null && { to: f.to }),
  ...(f.types.length > 0 && { type: f.types }),
  ...(f.issuer !== null && { issuer: f.issuer }),
  ...(f.family !== null && { family: f.family }),
  ...(f.felul !== null && { felul: f.felul }),
  ...(f.versions !== null && { versions: f.versions }),
});

const lensOf = (
  field: string,
  value: string | undefined,
  fallback: LegalAnalyticsLens
): Result<LegalAnalyticsLens, ApiError> => {
  const lens = value ?? fallback;
  return isOneOf(LEGAL_ANALYTICS_LENSES, lens)
    ? ok(lens)
    : err(invalidInput(`${field} must be one of ${LEGAL_ANALYTICS_LENSES.join(', ')}`, field));
};

const keyOf = (view: LegalAnalyticsView, canonical: Record<string, unknown>): string =>
  `${view}?${JSON.stringify(canonical)}`;

const made = (view: LegalAnalyticsView, canonical: Record<string, unknown>) => ({
  key: keyOf(view, canonical),
  args: canonical,
});

/**
 * The acts list's cursor: base64url of [layer id, the request key without the
 * cursor, sort value, act id]. A cursor of another layer, filter or order is
 * refused; the caller starts again from the first page.
 */
/** A cursor is short: base64url of a 4-tuple of ids, a canonical key and two numbers. */
export const MAX_CURSOR_LENGTH = 2_048;
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
const INT8_MAX = 9_223_372_036_854_775_807n;
const CursorTuple = Type.Tuple([
  Type.String({ pattern: '^[0-9]{1,19}$' }),
  Type.String({ maxLength: MAX_CURSOR_LENGTH }),
  Type.Integer({ minimum: INT4_MIN, maximum: INT4_MAX }),
  Type.String({ pattern: '^[0-9]{1,19}$' }),
]);

export const encodeActsCursor = (
  layerId: string,
  key: string,
  position: LegalAnalyticsActsCursor
): string =>
  Buffer.from(JSON.stringify([layerId, key, position.value, position.actId]), 'utf8').toString(
    'base64url'
  );

const decodeActsCursor = (
  cursor: string,
  layerId: string,
  key: string
): Result<LegalAnalyticsActsCursor, ApiError> => {
  const refused = err(
    invalidInput(
      'cursor belongs to another layer, filter or order; start again without it',
      'cursor'
    )
  );
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor)) return refused;
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return refused;
  }
  if (!Value.Check(CursorTuple, parts)) return refused;
  const [layer, forKey, value, actId] = parts;
  if (layer !== layerId || forKey !== key) return refused;
  // the sort value is an SQL integer (checked by the schema), the act id an SQL bigint
  if (BigInt(actId) > INT8_MAX) return refused;
  return ok({ value, actId });
};

/** Validate one surface's arguments for a view against the pinned layer's head. */
export const parseLegalAnalyticsRequest = (
  view: LegalAnalyticsView,
  args: LegalAnalyticsArgs,
  head: LegalAnalyticsHead
): Result<LegalAnalyticsRequest, ApiError> => {
  const allowed = VIEW_ARGS[view];
  for (const [name, value] of Object.entries(args)) {
    if (value !== undefined && !(allowed as readonly string[]).includes(name))
      return err(invalidInput(`${name} is not an argument of the ${view} view`, name));
  }
  if (view === 'head') return ok({ view, ...made(view, {}) });
  const parsed = parseFilter(args, head);
  if (parsed.isErr()) return err(parsed.error);
  const filter = parsed.value;
  const base = canonicalFilter(filter);

  switch (view) {
    case 'summary':
    case 'links':
      return ok({ view, ...made(view, base), filter });
    case 'breakdown': {
      const lens = lensOf('lens', args.lens, 'felul');
      if (lens.isErr()) return err(lens.error);
      const limit = intIn('limit', args.limit, 1, BREAKDOWN_LIMIT.max);
      if (limit.isErr()) return err(limit.error);
      const n = limit.value ?? BREAKDOWN_LIMIT.default;
      const canonical = {
        ...base,
        ...(lens.value !== 'felul' && { lens: lens.value }),
        ...(n !== BREAKDOWN_LIMIT.default && { limit: n }),
      };
      return ok({ view, ...made(view, canonical), filter, lens: lens.value, limit: n });
    }
    case 'series': {
      const lens = lensOf('lens', args.lens, 'felul');
      if (lens.isErr()) return err(lens.error);
      if (lens.value === 'year')
        return err(invalidInput('a series is already by year; pick another lens', 'lens'));
      const top = intIn('top', args.top, 1, SERIES_TOP.max);
      if (top.isErr()) return err(top.error);
      const n = top.value ?? SERIES_TOP.default;
      const canonical = {
        ...base,
        ...(lens.value !== 'felul' && { lens: lens.value }),
        ...(n !== SERIES_TOP.default && { top: n }),
      };
      return ok({ view, ...made(view, canonical), filter, lens: lens.value, top: n });
    }
    case 'grid': {
      const lens = lensOf('lens', args.lens, 'felul');
      if (lens.isErr()) return err(lens.error);
      const by = lensOf('by', args.by, lens.value === 'type' ? 'felul' : 'type');
      if (by.isErr()) return err(by.error);
      if (by.value === lens.value) return err(invalidInput('by must differ from lens', 'by'));
      const canonical = {
        ...base,
        ...(lens.value !== 'felul' && { lens: lens.value }),
        ...(by.value !== (lens.value === 'type' ? 'felul' : 'type') && { by: by.value }),
      };
      return ok({ view, ...made(view, canonical), filter, lens: lens.value, by: by.value });
    }
    case 'acts': {
      const order = args.order ?? 'amended';
      if (!isOneOf(LEGAL_ANALYTICS_ORDERS, order))
        return err(
          invalidInput(`order must be one of ${LEGAL_ANALYTICS_ORDERS.join(', ')}`, 'order')
        );
      const limit = intIn('limit', args.limit, 1, ACTS_LIMIT.max);
      if (limit.isErr()) return err(limit.error);
      const n = limit.value ?? ACTS_LIMIT.default;
      const canonical = {
        ...base,
        ...(order !== 'amended' && { order }),
        ...(n !== ACTS_LIMIT.default && { limit: n }),
      };
      const pageKey = keyOf(view, canonical);
      let after: LegalAnalyticsActsCursor | null = null;
      if (args.cursor !== undefined) {
        const decoded = decodeActsCursor(args.cursor, head.layer.layerId, pageKey);
        if (decoded.isErr()) return err(decoded.error);
        after = decoded.value;
      }
      const key =
        after === null ? pageKey : keyOf(view, { ...canonical, after: [after.value, after.actId] });
      return ok({
        view,
        key,
        pageKey,
        args: args.cursor === undefined ? canonical : { ...canonical, cursor: args.cursor },
        filter,
        order: order,
        limit: n,
        after,
      });
    }
  }
};
