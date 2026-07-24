/**
 * Procurement module — offset-search core (the client contract, graphql-api-spec.md
 * §"search (offset)"). Pure: validation, the sort→column map, `q` bounds + ILIKE
 * escaping, the page-window cap and the capped-count interpretation. No I/O, no SQL
 * — the repo compiles these decisions into predicates.
 *
 * Why a hand-authored filter type rather than the kernel `FilterInput`: the kernel
 * composer's `fhashFor(spec, input)` canonicalizes over the FULL spec, so adding the
 * fields this surface needs (`q`, `sourceSystem` on procedures/contracts) would
 * silently change the cursor `fhash` of the EXISTING cursor lists that the MCP tools
 * page through. This surface therefore owns its own validated filter object; the
 * cursor surface and its specs are untouched.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import {
  DEFAULT_SEARCH_SORT,
  DA_OFFSET_SELECTIVE_FIELDS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  Q_MAX_LENGTH,
  Q_MIN_LENGTH,
  SEARCH_COUNT_CAP,
  SEARCH_SORTS,
  SEARCH_WINDOW_MAX,
  type SearchSort,
} from './constants.js';

import type { OffsetSearchRequest, OffsetSearchResult } from './types.js';

// ── the validated filter (one shape; per-grain fields are optional) ────────────

export interface DateRange {
  readonly gte?: string;
  readonly lte?: string;
}
export interface DecimalRange {
  readonly gte?: string;
  readonly lte?: string;
}

/**
 * One side's territory scope. The three levels are mutually exclusive in the
 * product contract (finest wins, resolved client-side); the server accepts
 * whatever arrives and ANDs it — a contradictory pair yields an empty page
 * rather than a silently-widened one.
 *
 * Buyer = the contracting institution's administrative territory. Supplier =
 * the awarded company's registered office (`companies_v2.territory_resolution`
 * → `core.territories`, the same resolution ClickHouse uses).
 */
export interface ProcurementGeoScope {
  readonly region?: string;
  readonly countyCode?: string;
  readonly siruta?: string;
}

export interface ProcurementSearchFilter {
  readonly q?: string;
  readonly authorityCui?: string;
  readonly supplierCui?: string;
  readonly cpvDivision?: string;
  readonly cpvCode?: string;
  /** Canonical 8-digit CPV level codes — compiled as a prefix at 3/4/5 digits. */
  readonly cpvGroup?: string;
  readonly cpvClass?: string;
  readonly cpvCategory?: string;
  /** Territory of the contracting institution. Search-engine served. */
  readonly buyerGeo?: ProcurementGeoScope;
  /**
   * Territory of the awarded supplier. Search-engine served, and structurally
   * absent on `procedures` — a procedure predates its award, so the parser
   * REJECTS the scope there instead of ignoring it (product requirement:
   * "the control must explain this rather than silently ignoring it").
   */
  readonly supplierGeo?: ProcurementGeoScope;
  readonly sourceSystem?: readonly string[];
  readonly status?: readonly string[];
  readonly dateRange?: DateRange;
  readonly valueRon?: DecimalRange;
  /** Valued grains only (ignored on modifications): value-model state filter. */
  readonly valueState?: readonly string[];
  /**
   * Contracts only (ignored elsewhere): record-kind filter
   * (contract_award | framework_agreement). NULL rows (pre-v5 stamp) match
   * 'contract_award'.
   */
  readonly recordKind?: readonly string[];
  /** Modifications only: `contract_id IS (NOT) NULL`. */
  readonly linked?: boolean;
  /** Modifications only: `value_delta_ron / nullif(value_before_ron,0) >= pct`. */
  readonly minDeltaPct?: number;
}

export type SearchGrain = 'procedures' | 'contracts' | 'direct_acquisitions' | 'modifications';

/**
 * CPV hierarchy levels: canonical 8-digit codes with a non-zero level digit and
 * trailing zeros (group `XXY00000`, class `XXXY0000`, category `XXXXY000`). A
 * level scope compiles to a `cpv_code` PREFIX at the level's digit length —
 * identical to the ClickHouse analytics rule, so the two surfaces agree.
 */
export const CPV_LEVELS = {
  cpvGroup: { pattern: /^\d{2}[1-9]0{5}$/u, digits: 3 },
  cpvClass: { pattern: /^\d{3}[1-9]0{4}$/u, digits: 4 },
  cpvCategory: { pattern: /^\d{4}[1-9]0{3}$/u, digits: 5 },
} as const;
export type CpvLevelKey = keyof typeof CPV_LEVELS;

/** True when a filter names a dimension only the search engine carries. */
export const usesEngineOnlyFilter = (f: ProcurementSearchFilter): boolean =>
  f.buyerGeo !== undefined ||
  f.supplierGeo !== undefined ||
  f.cpvGroup !== undefined ||
  f.cpvClass !== undefined ||
  f.cpvCategory !== undefined;

/** Result-set facet dimensions the engine may aggregate, per grain. */
export const SEARCH_FACET_DIMS: Readonly<Record<SearchGrain, readonly string[]>> = {
  procedures: [
    'buyerRegion',
    'buyerCounty',
    'cpvDivision',
    'status',
    'valueState',
    'sourceSystem',
    'procedureType',
  ],
  contracts: [
    'buyerRegion',
    'buyerCounty',
    'supplierRegion',
    'supplierCounty',
    'cpvDivision',
    'status',
    'valueState',
    'sourceSystem',
    'recordKind',
  ],
  direct_acquisitions: [
    'buyerRegion',
    'buyerCounty',
    'supplierRegion',
    'supplierCounty',
    'cpvDivision',
    'status',
    'valueState',
    'sourceSystem',
  ],
  // Not indexed — the modifications grain is served by SQL only.
  modifications: [],
};

/** Max buckets returned per facet dimension; the remainder is disclosed, never hidden. */
export const SEARCH_FACET_SIZE = 30;

// ── sort → (date column, value column) per grain ───────────────────────────────

interface SortColumns {
  readonly date: string;
  /** Null when the grain has no orderable money column (none currently). */
  readonly value: string;
  /** The surrogate PK — the total-order tiebreak. */
  readonly pk: string;
}

const SORT_COLUMNS: Readonly<Record<SearchGrain, SortColumns>> = {
  // Value-model: value sorts order by the RESOLVED comparable measure —
  // frameworks/conflicts (no comparable) fall to NULLS LAST. Modifications
  // keep the delta (no resolution on that grain).
  procedures: { date: 'publication_date', value: 'value_ron_comparable', pk: 'procedure_id' },
  contracts: { date: 'contract_date', value: 'value_ron_comparable', pk: 'contract_id' },
  direct_acquisitions: {
    date: 'finalization_date',
    value: 'value_ron_comparable',
    pk: 'da_id',
  },
  modifications: { date: 'modification_date', value: 'value_delta_ron', pk: 'modification_id' },
};

export interface ResolvedSort {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
  readonly pk: string;
}

/**
 * Resolve a sort token to `(column, direction, pk)`. The caller emits
 * `ORDER BY column direction NULLS LAST, pk DESC` — a TOTAL order, so an offset
 * page can never shuffle rows that tie on the sort column.
 */
export const resolveSort = (grain: SearchGrain, sort: SearchSort): ResolvedSort => {
  const cols = SORT_COLUMNS[grain];
  const byDate = sort === 'date_desc' || sort === 'date_asc';
  const ascending = sort === 'date_asc' || sort === 'value_asc';
  return {
    column: byDate ? cols.date : cols.value,
    direction: ascending ? 'asc' : 'desc',
    pk: cols.pk,
  };
};

export const isSearchSort = (v: unknown): v is SearchSort =>
  typeof v === 'string' && (SEARCH_SORTS as readonly string[]).includes(v);

// ── page request ──────────────────────────────────────────────────────────────

/**
 * Validate `page`/`pageSize`/`sort`. `page * pageSize` must stay within
 * `SEARCH_WINDOW_MAX`: beyond that an OFFSET stops being a seek and the planner
 * walks (and discards) every skipped row.
 */
export const parseOffsetRequest = (
  page: number | undefined,
  pageSize: number | undefined,
  sort: string | undefined
): Result<OffsetSearchRequest, ApiError> => {
  const p = page ?? 1;
  const size = pageSize ?? PAGE_SIZE_DEFAULT;
  if (!Number.isInteger(p) || p < 1)
    return err(invalidInput('page must be a positive integer', 'page'));
  if (!Number.isInteger(size) || size < 1 || size > PAGE_SIZE_MAX) {
    return err(invalidInput(`pageSize must be between 1 and ${String(PAGE_SIZE_MAX)}`, 'pageSize'));
  }
  if (p * size > SEARCH_WINDOW_MAX) {
    return err(
      invalidInput(
        `page * pageSize must not exceed ${String(SEARCH_WINDOW_MAX)} — narrow the filter instead of paging deeper`,
        'page'
      )
    );
  }
  if (sort !== undefined && !isSearchSort(sort)) {
    return err(invalidInput(`sort must be one of ${SEARCH_SORTS.join(', ')}`, 'sort'));
  }
  return ok({ page: p, pageSize: size, sort: sort ?? DEFAULT_SEARCH_SORT });
};

export const offsetOf = (req: OffsetSearchRequest): number => (req.page - 1) * req.pageSize;

// ── free-text `q` ─────────────────────────────────────────────────────────────

/**
 * Escape the LIKE metacharacters so a user's `%`/`_`/`\` is matched literally.
 * The caller must pair the pattern with `ESCAPE '\'`.
 */
export const escapeLikePattern = (raw: string): string =>
  `%${raw.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;

/** Bound `q`: a 1–2 char `%x%` matches most of the table and degenerates to a scan. */
export const parseQ = (raw: string | undefined): Result<string | undefined, ApiError> => {
  if (raw === undefined) return ok(undefined);
  const q = raw.trim();
  if (q.length < Q_MIN_LENGTH) {
    return err(invalidInput(`q must be at least ${String(Q_MIN_LENGTH)} characters`, 'q'));
  }
  if (q.length > Q_MAX_LENGTH) {
    return err(invalidInput(`q must be at most ${String(Q_MAX_LENGTH)} characters`, 'q'));
  }
  return ok(q);
};

/** The columns `q` searches, per grain (all btree-indexed or short text). */
export const Q_COLUMNS: Readonly<Record<SearchGrain, readonly string[]>> = {
  procedures: ['title', 'notice_no'],
  contracts: ['title', 'contract_no', 'notice_no'],
  direct_acquisitions: ['title', 'unique_code'],
  modifications: ['contract_no', 'notice_no'],
};

// ── direct-acquisition selectivity (the 26M-row grain) ────────────────────────

/**
 * The OFFSET surface admits a DA search only when a qualifying dimension bounds
 * the set the planner must SORT. See `DA_OFFSET_SELECTIVE_FIELDS` for the live
 * measurements: `cpvDivision`, `cpvCode`, `uniqueCode` and `q` all fail to bound it
 * (16.6s / 8.0s against a 15s statement timeout), so they refine but never qualify.
 * A `dateRange` qualifies only when BOTH bounds are present and the span is capped.
 */
export const assertDaOffsetSelective = (
  filter: ProcurementSearchFilter,
  maxWindowDays: number
): Result<void, ApiError> => {
  for (const field of DA_OFFSET_SELECTIVE_FIELDS) {
    const value = filter[field];
    if (typeof value === 'string' && value.trim() !== '') return ok(undefined);
  }
  const { gte, lte } = filter.dateRange ?? {};
  if (gte !== undefined && lte !== undefined) {
    const from = Date.parse(gte);
    const to = Date.parse(lte);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      const days = (to - from) / 86_400_000;
      if (days < 0) return err(invalidInput('date range is inverted', 'publicationDate'));
      if (days <= maxWindowDays) return ok(undefined);
      return err(
        invalidInput(
          `direct-acquisition date window must be ≤ ${String(maxWindowDays)} days (got ${String(Math.round(days))})`,
          'publicationDate'
        )
      );
    }
  }
  return err(
    invalidInput(
      'direct-acquisition search requires authorityCui, supplierCui, or a fully-bounded date range ' +
        `of ≤ ${String(maxWindowDays)} days; CPV and free-text q refine such a filter but cannot stand alone`,
      'filter'
    )
  );
};

// ── capped exact count ────────────────────────────────────────────────────────

/**
 * Interpret the capped count. The repo runs
 * `select count(*) from (select 1 … limit CAP+1) t` in PARALLEL with the page:
 *   - `n <= CAP`  → exact `total`, `estimated: false`
 *   - `n === CAP+1` → `total: null`, `estimated: true` (the client renders "10000+")
 *   - the count FAILED (timeout) → `total: null`, `estimated: true`; the page still
 *     serves. A slow count must degrade, never fail the request.
 */
export const interpretCappedCount = <T>(
  items: readonly T[],
  count: number | null,
  cap: number = SEARCH_COUNT_CAP
): OffsetSearchResult<T> => {
  if (count === null || count > cap) return { items, total: null, estimated: true };
  return { items, total: count, estimated: false };
};
