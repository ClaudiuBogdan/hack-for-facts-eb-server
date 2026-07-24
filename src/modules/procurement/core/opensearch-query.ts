/**
 * Procurement module — the OpenSearch list query, compiled (pure).
 *
 * The search engine is the record LIST engine for the three indexed grains
 * (scrapper `prod-db/PROCUREMENT_SEARCH_LIST_ENGINE_PLAN.md`): it owns the
 * filters, the total order, the page window and the count; Postgres hydrates
 * the ≤100 rows of the requested page by primary key. This module compiles a
 * validated `ProcurementSearchFilter` into the request body — no I/O, so the
 * predicate-by-predicate parity with the SQL path is unit-testable.
 *
 * Parity rules that must not drift from `offset-search-repo.ts`:
 *  1. Dates and date sorts bind to `date_list` — the grain's OWN date
 *     (`contract_date` / `finalization_date` / `publication_date`), NOT
 *     `date_basis` (which back-fills nulls for analytics and would widen the
 *     filter: 113k contracts / 1.0M DAs / 369k procedures have a null own date).
 *  2. Value filters and value sorts bind to `value_comparable_bani` — the
 *     RESOLVED comparable measure, never awarded/estimated.
 *  3. `NULLS LAST` on both directions → `missing: '_last'`.
 *  4. The tiebreak is the numeric `pk`, never `record_id` (a grain-prefixed
 *     keyword sorts lexically).
 *  5. An explicit empty `in: []` matches NOTHING (an empty `terms` clause).
 *  6. Documents are canonical-only by construction (build-time predicate).
 */

import {
  CPV_LEVELS,
  SEARCH_FACET_SIZE,
  type CpvLevelKey,
  type ProcurementGeoScope,
  type ProcurementSearchFilter,
  type SearchGrain,
} from './search.js';

import type { OffsetSearchRequest } from './types.js';

/** Facet dimension → the document keyword field it aggregates. */
export const FACET_FIELDS: Readonly<Record<string, string>> = {
  buyerRegion: 'buyer_region',
  buyerCounty: 'buyer_county_code',
  buyerSiruta: 'buyer_siruta',
  supplierRegion: 'supplier_region',
  supplierCounty: 'supplier_county_code',
  supplierSiruta: 'supplier_siruta',
  cpvDivision: 'cpv_division',
  status: 'status',
  valueState: 'value_state',
  sourceSystem: 'source_system',
  recordKind: 'record_kind',
  procedureType: 'procedure_type',
};

/** The BM25 field set. Codes are keyword fields and never take fuzziness. */
const Q_FIELDS = [
  'title^3',
  'title.folded^3',
  'authority_name',
  'authority_name.folded',
  'supplier_name',
  'supplier_name.folded',
] as const;

type Clause = Record<string, unknown>;

/** Finest level first — a category scope beats a class scope beats a group. */
const CPV_LEVEL_ORDER: readonly CpvLevelKey[] = ['cpvCategory', 'cpvClass', 'cpvGroup'];

const term = (field: string, value: string): Clause => ({ term: { [field]: value } });
const terms = (field: string, values: readonly string[]): Clause => ({
  terms: { [field]: [...values] },
});

/**
 * RON decimal string → bani, without ever becoming a float. A lower bound
 * rounds UP and an upper bound rounds DOWN, so a fractional bound can only
 * ever narrow the set — never admit a row Postgres would exclude.
 */
export const ronToBani = (decimal: string, bound: 'gte' | 'lte'): number | string => {
  const negative = decimal.startsWith('-');
  const [wholeRaw = '', fracRaw = ''] = (negative ? decimal.slice(1) : decimal).split('.');
  const whole = BigInt(wholeRaw === '' ? '0' : wholeRaw);
  const cents = BigInt((fracRaw + '00').slice(0, 2));
  const rest = fracRaw.slice(2).replace(/0+$/u, '');
  const exact = whole * 100n + cents;
  const sign = negative ? -1n : 1n;
  // `rest` non-empty ⇒ the true value lies strictly between `exact` and the
  // next bani step (away from zero for a positive number).
  const magnitude = rest === '' || (sign === 1n) !== (bound === 'gte') ? exact : exact + 1n;
  const value = sign * magnitude;
  // Beyond the safe-integer range a JS number would silently round — and
  // rounding a bound OUTWARD admits rows Postgres excludes. `long` range
  // clauses accept a numeric string, so the exact value travels as text.
  return magnitude > BigInt(Number.MAX_SAFE_INTEGER) ? value.toString() : Number(value);
};

const geoClauses = (side: 'buyer' | 'supplier', geo: ProcurementGeoScope): Clause[] => {
  const out: Clause[] = [];
  if (geo.region !== undefined) out.push(term(`${side}_region`, geo.region));
  if (geo.countyCode !== undefined) out.push(term(`${side}_county_code`, geo.countyCode));
  if (geo.siruta !== undefined) out.push(term(`${side}_siruta`, geo.siruta));
  return out;
};

/**
 * CPV: an exact code wins over a level, a level wins over the division — the
 * same precedence the SQL path applies (`cpvCode` beats `cpvDivision`).
 * A code shorter than 8 digits is a prefix, like the SQL left-anchored LIKE.
 */
const cpvClause = (f: ProcurementSearchFilter): Clause | null => {
  if (f.cpvCode !== undefined) {
    return f.cpvCode.length === 8
      ? term('cpv_code', f.cpvCode)
      : { prefix: { cpv_code: f.cpvCode } };
  }
  for (const key of CPV_LEVEL_ORDER) {
    const code = f[key];
    if (code !== undefined) {
      return { prefix: { cpv_code: code.slice(0, CPV_LEVELS[key].digits) } };
    }
  }
  if (f.cpvDivision !== undefined) return term('cpv_division', f.cpvDivision);
  return null;
};

/** Sort field per (grain-independent) sort token — both bind to list columns. */
const sortField = (sort: OffsetSearchRequest['sort']): string =>
  sort === 'date_desc' || sort === 'date_asc' ? 'date_list' : 'value_comparable_bani';

export interface CompiledListQuery {
  readonly body: Record<string, unknown>;
  /** Facet dimensions compiled into the body, in response order. */
  readonly facetDims: readonly string[];
}

export interface CompileListQueryOptions {
  readonly grain: SearchGrain;
  readonly filter: ProcurementSearchFilter;
  readonly page: OffsetSearchRequest;
  /** Validated facet dimensions (caller checks them against SEARCH_FACET_DIMS). */
  readonly facets?: readonly string[];
  /**
   * `true` = always-exact totals (measured 86 ms over 12.7M docs on a county
   * scope). A number caps the exact range and discloses `gte` beyond it.
   */
  readonly trackTotalHits?: boolean | number;
}

export const compileListQuery = ({
  grain,
  filter,
  page,
  facets = [],
  trackTotalHits = true,
}: CompileListQueryOptions): CompiledListQuery => {
  const filters: Clause[] = [];

  if (filter.authorityCui !== undefined) filters.push(term('authority_cui', filter.authorityCui));
  if (filter.supplierCui !== undefined) filters.push(term('supplier_cui', filter.supplierCui));

  const cpv = cpvClause(filter);
  if (cpv !== null) filters.push(cpv);

  if (filter.buyerGeo !== undefined) filters.push(...geoClauses('buyer', filter.buyerGeo));
  if (filter.supplierGeo !== undefined) filters.push(...geoClauses('supplier', filter.supplierGeo));

  if (filter.sourceSystem !== undefined) filters.push(terms('source_system', filter.sourceSystem));
  if (filter.status !== undefined) filters.push(terms('status', filter.status));
  if (filter.valueState !== undefined) filters.push(terms('value_state', filter.valueState));
  // `record_kind` is stamped `coalesce(record_kind,'contract_award')` at build
  // time, so the term filter needs no null handling (SQL coalesces identically).
  if (filter.recordKind !== undefined && grain === 'contracts') {
    filters.push(terms('record_kind', filter.recordKind));
  }

  if (filter.dateRange !== undefined) {
    const range: Record<string, string> = {};
    if (filter.dateRange.gte !== undefined) range['gte'] = filter.dateRange.gte;
    if (filter.dateRange.lte !== undefined) range['lte'] = filter.dateRange.lte;
    filters.push({ range: { date_list: range } });
  }

  if (filter.valueRon !== undefined) {
    const range: Record<string, number | string> = {};
    if (filter.valueRon.gte !== undefined) range['gte'] = ronToBani(filter.valueRon.gte, 'gte');
    if (filter.valueRon.lte !== undefined) range['lte'] = ronToBani(filter.valueRon.lte, 'lte');
    filters.push({ range: { value_comparable_bani: range } });
  }

  const must: Clause[] =
    filter.q === undefined
      ? []
      : [
          {
            multi_match: {
              query: filter.q,
              fields: [...Q_FIELDS],
              type: 'best_fields',
              fuzziness: 'AUTO',
              prefix_length: 1,
              max_expansions: 50,
            },
          },
        ];

  const ascending = page.sort === 'date_asc' || page.sort === 'value_asc';
  const aggs: Record<string, unknown> = {};
  const facetDims: string[] = [];
  for (const dim of facets) {
    const field = FACET_FIELDS[dim];
    if (field === undefined) continue;
    aggs[dim] = { terms: { field, size: SEARCH_FACET_SIZE } };
    facetDims.push(dim);
  }

  return {
    body: {
      from: (page.page - 1) * page.pageSize,
      size: page.pageSize,
      _source: false,
      track_total_hits: trackTotalHits,
      query: { bool: { ...(must.length > 0 && { must }), filter: filters } },
      sort: [
        { [sortField(page.sort)]: { order: ascending ? 'asc' : 'desc', missing: '_last' } },
        { pk: 'desc' },
      ],
      ...(facetDims.length > 0 && { aggs }),
    },
    facetDims,
  };
};
