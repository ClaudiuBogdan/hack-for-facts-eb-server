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

import {
  ANALYSIS_GRAINS,
  FRAMEWORK_ROLE_FILTERS,
  Q_MAX_LENGTH,
  Q_MIN_LENGTH,
  RECORD_KINDS,
  type AnalysisGrain,
  type FrameworkRoleFilter,
  type RecordKind,
} from './constants.js';

export interface AnalysisScope {
  readonly authorityCui?: string;
  readonly supplierCui?: string;
  /** CPV hierarchy scopes — at most ONE level per scope, finest wins semantics. */
  readonly cpvDivision?: string;
  readonly cpvGroup?: string;
  readonly cpvClass?: string;
  readonly cpvCategory?: string;
  readonly cpvCode?: string;
  readonly buyerCounty?: string;
  readonly buyerRegion?: string;
  readonly buyerSiruta?: string;
  readonly supplierCounty?: string;
  readonly supplierRegion?: string;
  readonly supplierSiruta?: string;
  readonly status?: string;
  readonly procedureType?: string;
  /** Contract-grain only: award record vs framework umbrella. */
  readonly recordKind?: RecordKind;
  /**
   * Contract-grain only. UNSET means the purchases-only default (standalone
   * or not-yet-stamped); `all` opts back into ceilings and call-offs.
   */
  readonly frameworkRole?: FrameworkRoleFilter;
  readonly grain?: AnalysisGrain;
  /** `YYYY-MM`, inclusive. Mutually exclusive with `year`. */
  readonly from?: string;
  readonly to?: string;
  readonly year?: number;
  /** Free-text title filter on aggregates (title coverage caveat applies). */
  readonly q?: string;
  /** Awarded-value bounds in RON — restrict to accepted-value rows in range. */
  readonly valueMin?: number;
  readonly valueMax?: number;
}

/** The scope fields that are dimensions (not time, not grain, not row filters). */
export const SCOPE_DIM_FIELDS = [
  'authorityCui',
  'supplierCui',
  'cpvDivision',
  'cpvGroup',
  'cpvClass',
  'cpvCategory',
  'cpvCode',
  'buyerCounty',
  'buyerRegion',
  'buyerSiruta',
  'supplierCounty',
  'supplierRegion',
  'supplierSiruta',
  'status',
  'procedureType',
  'recordKind',
  'frameworkRole',
] as const;
export type ScopeDimField = (typeof SCOPE_DIM_FIELDS)[number];

/**
 * `q`/`valueMin`/`valueMax` are ROW FILTERS, not dimensions: they never join
 * `scopeDims` (the single-bucket breakdown rejection reasons over dimension
 * fields only), but they DO participate in share-subset validation — a
 * denominator row filter absent from the numerator breaks the subset law.
 */
export const SCOPE_ROW_FILTER_FIELDS = ['q', 'valueMin', 'valueMax'] as const;

export const SCOPE_FIELDS = [
  ...SCOPE_DIM_FIELDS,
  'grain',
  'from',
  'to',
  'year',
  ...SCOPE_ROW_FILTER_FIELDS,
] as const;

// ── the fhash/echo spec (all-virtual; never compiled to SQL) ───────────────────

const virtualField = (name: string, type: 'string' | 'int' | 'number' = 'string') =>
  ({
    name,
    type,
    ops: ['eq'],
    virtual: true,
    column: { alias: 'x', column: name },
  }) as const;

const specFieldType = (field: string): 'string' | 'int' | 'number' => {
  if (field === 'year') return 'int';
  if (field === 'valueMin' || field === 'valueMax') return 'number';
  return 'string';
};

export const ANALYSIS_SCOPE_SPEC: CollectionFilterSpec = {
  collection: 'procurement_analysis_scope',
  fields: SCOPE_FIELDS.map((f) => virtualField(f, specFieldType(f))),
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
// CPV hierarchy levels are canonical 8-digit codes with trailing zeros and a
// non-zero level digit (measured 2026-07-24: all 272 groups / 1,002 classes /
// 2,379 categories in procurement.cpv_codes match; a zero level digit would be
// the coarser level's own code).
const CPV_GROUP_RE = /^\d{2}[1-9]0{5}$/u;
const CPV_CLASS_RE = /^\d{3}[1-9]0{4}$/u;
const CPV_CATEGORY_RE = /^\d{4}[1-9]0{3}$/u;

/** RON bound cap — far above any observed award; guards bani exactness. */
const VALUE_BOUND_MAX_RON = 1_000_000_000_000;

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
 * month shapes, `from <= to`, `year` XOR `from`/`to`, at most one CPV level
 * (division/group/class/category/code), the recordKind enum, `q` length,
 * value-bound ranges, CUI normalization, and the grain enum. Absent/null → the
 * empty (platform) scope.
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
    'cpvGroup',
    'cpvClass',
    'cpvCategory',
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
    'q',
  ] as const) {
    const value = readString(raw[field], field);
    if (value.isErr()) return err(value.error);
    if (value.value !== undefined) out[field] = value.value;
  }

  if (out.cpvDivision !== undefined && !DIVISION_RE.test(out.cpvDivision)) {
    return err(invalidInput('cpvDivision must be a 2-digit division code', 'cpvDivision'));
  }
  for (const [field, re, label] of [
    ['cpvGroup', CPV_GROUP_RE, 'group (XXY00000, Y≠0)'],
    ['cpvClass', CPV_CLASS_RE, 'class (XXXY0000, Y≠0)'],
    ['cpvCategory', CPV_CATEGORY_RE, 'category (XXXXY000, Y≠0)'],
  ] as const) {
    if (out[field] !== undefined && !re.test(out[field])) {
      return err(invalidInput(`${field} must be a canonical 8-digit CPV ${label} code`, field));
    }
  }
  if (out.cpvCode !== undefined && !CPV_CODE_RE.test(out.cpvCode)) {
    return err(invalidInput('cpvCode must be an 8-digit CPV code', 'cpvCode'));
  }
  {
    const cpvSet = (
      ['cpvDivision', 'cpvGroup', 'cpvClass', 'cpvCategory', 'cpvCode'] as const
    ).filter((f) => out[f] !== undefined);
    if (cpvSet.length > 1) {
      return err(
        invalidInput(
          `CPV scope levels are mutually exclusive — pass one of cpvDivision/cpvGroup/cpvClass/cpvCategory/cpvCode (got ${cpvSet.join(', ')})`,
          cpvSet[1]
        )
      );
    }
  }

  const recordKind = readString(raw['recordKind'], 'recordKind');
  if (recordKind.isErr()) return err(recordKind.error);
  if (recordKind.value !== undefined) {
    if (!(RECORD_KINDS as readonly string[]).includes(recordKind.value)) {
      return err(
        invalidInput(`recordKind must be one of ${RECORD_KINDS.join(', ')}`, 'recordKind')
      );
    }
    out.recordKind = recordKind.value as RecordKind;
  }

  const frameworkRole = readString(raw['frameworkRole'], 'frameworkRole');
  if (frameworkRole.isErr()) return err(frameworkRole.error);
  if (frameworkRole.value !== undefined) {
    if (!(FRAMEWORK_ROLE_FILTERS as readonly string[]).includes(frameworkRole.value)) {
      return err(
        invalidInput(
          `frameworkRole must be one of ${FRAMEWORK_ROLE_FILTERS.join(', ')}`,
          'frameworkRole'
        )
      );
    }
    out.frameworkRole = frameworkRole.value as FrameworkRoleFilter;
  }

  if (out.q !== undefined && (out.q.length < Q_MIN_LENGTH || out.q.length > Q_MAX_LENGTH)) {
    return err(
      invalidInput(`q must be ${String(Q_MIN_LENGTH)}–${String(Q_MAX_LENGTH)} characters`, 'q')
    );
  }

  for (const field of ['valueMin', 'valueMax'] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > VALUE_BOUND_MAX_RON
    ) {
      return err(invalidInput(`${field} must be a RON amount between 0 and 10^12`, field));
    }
    // Bani exactness: at most 2 decimals (the epsilon absorbs binary float
    // representation of e.g. 1.05, but rejects genuine sub-bani inputs).
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      return err(invalidInput(`${field} must have at most 2 decimals (whole bani)`, field));
    }
    out[field] = value;
  }
  if (out.valueMin !== undefined && out.valueMax !== undefined && out.valueMin > out.valueMax) {
    return err(invalidInput('valueMin must not exceed valueMax', 'valueMin'));
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

/**
 * True when the scope slices the supplier dimension — the repo elects the
 * supplier-money profile for these (D3=C: named-supplier money, association
 * mass withheld). Mirrors the repo's SUPPLIER_SCOPE_FIELDS; the usecases need
 * the same predicate to keep gate/caveat semantics aligned with the columns
 * the repo actually reads.
 */
export const supplierScoped = (scope: AnalysisScope): boolean =>
  scope.supplierCui !== undefined ||
  scope.supplierCounty !== undefined ||
  scope.supplierRegion !== undefined ||
  scope.supplierSiruta !== undefined;

/** The row-filter fields actually set on a scope (they narrow, like dims). */
export const scopeRowFilters = (
  scope: AnalysisScope
): readonly (typeof SCOPE_ROW_FILTER_FIELDS)[number][] =>
  SCOPE_ROW_FILTER_FIELDS.filter((f) => scope[f] !== undefined);

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
 * Row filters (q/valueMin/valueMax) participate — a denominator row filter
 * absent from the numerator breaks the subset law. Time fields are checked
 * separately (share requires an identical period).
 */
export const isSubsetScope = (numerator: AnalysisScope, denominator: AnalysisScope): boolean =>
  scopeDims(denominator).every((field) => numerator[field] === denominator[field]) &&
  SCOPE_ROW_FILTER_FIELDS.every(
    (field) => denominator[field] === undefined || numerator[field] === denominator[field]
  );

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

/**
 * Cacheable ⟺ no entity anchor and no free-text/value row filter (bounded key
 * space; entity scopes are index-fast; `q`/value bounds are unbounded inputs
 * that would flood the cache with single-use keys).
 */
export const isCacheableAnalysisScope = (scope: AnalysisScope): boolean =>
  scope.authorityCui === undefined &&
  scope.supplierCui === undefined &&
  scope.q === undefined &&
  scope.valueMin === undefined &&
  scope.valueMax === undefined;
