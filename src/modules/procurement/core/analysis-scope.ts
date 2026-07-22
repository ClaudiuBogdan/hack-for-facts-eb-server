/**
 * Procurement analysis — ONE scope, many shapes (design §5.1).
 *
 * `AnalysisScope` is the single filter object every analysis shape accepts.
 * Parsing/validation is pure and shared by GraphQL and MCP, so both surfaces
 * reject the same inputs with the same messages.
 *
 * The all-virtual `CollectionFilterSpec` below exists ONLY so the kernel's
 * `canonicalizeFilters`/`fhashFor` derive stable cache keys and the envelope's
 * canonical scope echo from one declaration — no SQL is ever compiled from it
 * (every field is `virtual: true`; the analysis repo owns the rollup SQL).
 *
 * Buyer/supplier county, region, and SIRUTA PARSE here because they are stable
 * contract fields. The combinations matrix rejects shapes whose rollups are not
 * published yet with the specific missing capability named.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  normalizeCui,
  type ApiError,
  type CollectionFilterSpec,
  type FilterInput,
} from '@/modules/shared/index.js';

import { ANALYSIS_GRAINS, type AnalysisGrain } from './constants.js';

export interface AnalysisScope {
  readonly authorityCui?: string;
  readonly supplierCui?: string;
  readonly cpvDivision?: string;
  readonly cpvCode?: string;
  readonly buyerCounty?: string;
  readonly buyerRegion?: string;
  readonly buyerSiruta?: string;
  readonly supplierCounty?: string;
  readonly supplierRegion?: string;
  readonly supplierSiruta?: string;
  readonly status?: string;
  readonly procedureType?: string;
  readonly grain?: AnalysisGrain;
  /** `YYYY-MM`, inclusive. Mutually exclusive with `year`. */
  readonly from?: string;
  readonly to?: string;
  readonly year?: number;
}

/** The scope fields that are dimensions (not time, not grain). */
export const SCOPE_DIM_FIELDS = [
  'authorityCui',
  'supplierCui',
  'cpvDivision',
  'cpvCode',
  'buyerCounty',
  'buyerRegion',
  'buyerSiruta',
  'supplierCounty',
  'supplierRegion',
  'supplierSiruta',
  'status',
  'procedureType',
] as const;
export type ScopeDimField = (typeof SCOPE_DIM_FIELDS)[number];

export const SCOPE_FIELDS = [...SCOPE_DIM_FIELDS, 'grain', 'from', 'to', 'year'] as const;

// ── the fhash/echo spec (all-virtual; never compiled to SQL) ───────────────────

const virtualField = (name: string, type: 'string' | 'int' = 'string') =>
  ({
    name,
    type,
    ops: ['eq'],
    virtual: true,
    column: { alias: 'x', column: name },
  }) as const;

export const ANALYSIS_SCOPE_SPEC: CollectionFilterSpec = {
  collection: 'procurement_analysis_scope',
  fields: SCOPE_FIELDS.map((f) => virtualField(f, f === 'year' ? 'int' : 'string')),
  sort: { default: 'grain', allowed: ['grain'] },
};

/** Project a scope onto the kernel `FilterInput` shape (for `fhashFor`). */
export const scopeToFilterInput = (scope: AnalysisScope): FilterInput => {
  const out: Record<string, { eq: string | number }> = {};
  for (const field of SCOPE_FIELDS) {
    const value = scope[field];
    if (value !== undefined) out[field] = { eq: value };
  }
  return out;
};

// ── parsing / validation ───────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-\d{2}$/u;
const DIVISION_RE = /^\d{2}$/u;
const CPV_CODE_RE = /^\d{8}$/u;

const readString = (value: unknown, field: string): Result<string | undefined, ApiError> => {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== 'string' || value.trim() === '') {
    return err(invalidInput(`${field} must be a non-empty string`, field));
  }
  return ok(value.trim());
};

const isCalendarMonth = (value: string): boolean => {
  if (!MONTH_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12;
};

export type RawAnalysisScope = Readonly<Record<string, unknown>> | null | undefined;

/**
 * Parse + validate a raw scope object (GraphQL input / MCP Zod output). Enforces:
 * month shapes, `from <= to`, `year` XOR `from`/`to`, `cpvDivision` XOR `cpvCode`,
 * CUI normalization, and the grain enum. Absent/null → the empty (platform) scope.
 */
export const parseAnalysisScope = (raw: RawAnalysisScope): Result<AnalysisScope, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  const out: { -readonly [K in keyof AnalysisScope]: AnalysisScope[K] } = {};

  for (const field of ['authorityCui', 'supplierCui'] as const) {
    const value = readString(raw[field], field);
    if (value.isErr()) return err(value.error);
    if (value.value !== undefined) {
      const norm = normalizeCui(value.value);
      if (norm === null) return err(invalidInput(`${field} is not a valid CUI`, field));
      out[field] = norm;
    }
  }

  for (const field of [
    'cpvDivision',
    'cpvCode',
    'buyerCounty',
    'buyerRegion',
    'buyerSiruta',
    'supplierCounty',
    'supplierRegion',
    'supplierSiruta',
    'status',
    'procedureType',
    'from',
    'to',
  ] as const) {
    const value = readString(raw[field], field);
    if (value.isErr()) return err(value.error);
    if (value.value !== undefined) out[field] = value.value;
  }

  if (out.cpvDivision !== undefined && !DIVISION_RE.test(out.cpvDivision)) {
    return err(invalidInput('cpvDivision must be a 2-digit division code', 'cpvDivision'));
  }
  if (out.cpvCode !== undefined && !CPV_CODE_RE.test(out.cpvCode)) {
    return err(invalidInput('cpvCode must be an 8-digit CPV code', 'cpvCode'));
  }
  if (out.cpvDivision !== undefined && out.cpvCode !== undefined) {
    return err(
      invalidInput('cpvDivision and cpvCode are mutually exclusive — pass one', 'cpvCode')
    );
  }

  for (const field of ['from', 'to'] as const) {
    if (out[field] !== undefined && !isCalendarMonth(out[field])) {
      return err(
        invalidInput(
          `${field} must be a calendar month in YYYY-MM form (year 2000–2100, month 01–12)`,
          field
        )
      );
    }
  }
  if (out.from !== undefined && out.to !== undefined && out.from > out.to) {
    return err(invalidInput('from must not exceed to', 'from'));
  }

  const year = raw['year'];
  if (year !== undefined && year !== null) {
    if (typeof year !== 'number' || !Number.isInteger(year) || year < 2000 || year > 2100) {
      return err(invalidInput('year must be an integer year (2000–2100)', 'year'));
    }
    if (out.from !== undefined || out.to !== undefined) {
      return err(invalidInput('year and from/to are mutually exclusive — pass one', 'year'));
    }
    out.year = year;
  }

  const grain = raw['grain'];
  if (grain !== undefined && grain !== null) {
    if (typeof grain !== 'string' || !(ANALYSIS_GRAINS as readonly string[]).includes(grain)) {
      return err(
        invalidInput(
          `grain must be one of ${ANALYSIS_GRAINS.join(', ')}, or absent for all`,
          'grain'
        )
      );
    }
    out.grain = grain as AnalysisGrain;
  }

  return ok(out);
};

// ── derived helpers ────────────────────────────────────────────────────────────

/** The dimension fields actually set on a scope (time + grain excluded). */
export const scopeDims = (scope: AnalysisScope): readonly ScopeDimField[] =>
  SCOPE_DIM_FIELDS.filter((f) => scope[f] !== undefined);

/** The scope's month window, with `year` expanded. Undefined = non-temporal. */
export const scopeWindow = (
  scope: AnalysisScope
): { readonly from?: string; readonly to?: string } | undefined => {
  if (scope.year !== undefined) {
    const y = String(scope.year);
    return { from: `${y}-01`, to: `${y}-12` };
  }
  if (scope.from === undefined && scope.to === undefined) return undefined;
  return {
    ...(scope.from !== undefined && { from: scope.from }),
    ...(scope.to !== undefined && { to: scope.to }),
  };
};

/**
 * Share validation (design §3.3): the numerator population must be a subset of
 * the denominator's, which holds when every constraint the DENOMINATOR sets is
 * set identically on the numerator (the numerator may only ADD constraints).
 * Time fields are checked separately (share requires an identical period).
 */
export const isSubsetScope = (numerator: AnalysisScope, denominator: AnalysisScope): boolean =>
  scopeDims(denominator).every((field) => numerator[field] === denominator[field]);

/**
 * Identical period on both operands — a share prerequisite. Compared via the
 * NORMALIZED window, so `year: 2024` equals `from: 2024-01, to: 2024-12`.
 */
export const sameWindow = (a: AnalysisScope, b: AnalysisScope): boolean => {
  const wa = scopeWindow(a);
  const wb = scopeWindow(b);
  if (wa === undefined || wb === undefined) return wa === wb;
  return wa.from === wb.from && wa.to === wb.to;
};

/**
 * The canonical scope echo: stable, order-independent scope serialization for
 * the envelope's `canonicalScope` field. It is not a navigable URL.
 */
export const canonicalScopeEcho = (scope: AnalysisScope): string =>
  SCOPE_FIELDS.filter((f) => scope[f] !== undefined)
    .map((f) => `${f}=${encodeURIComponent(String(scope[f]))}`)
    .join('&');

/** Cacheable ⟺ no entity anchor (bounded key space; entity scopes are index-fast). */
export const isCacheableAnalysisScope = (scope: AnalysisScope): boolean =>
  scope.authorityCui === undefined && scope.supplierCui === undefined;
