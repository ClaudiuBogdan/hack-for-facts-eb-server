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
 *  7. `sort: relevance` orders by BM25 and keeps the numeric `pk` tiebreak, so
 *     the order is TOTAL within one response and stable across the `from/size`
 *     pages of ONE immutable, single-shard generation (verified: pages 1+2 ==
 *     a single 40-document window). It is NOT stable across a reshard — BM25
 *     uses shard-local term statistics by default — nor across a rebuild.
 *     Before the index grows past one shard, `dfs_query_then_fetch`, a fixed
 *     `preference` and PIT-pinned pagination all have to be measured.
 *  8. `q` reaches the identifier keyword fields the SQL path searched
 *     (`Q_COLUMNS`) as well as the analyzed name fields — routing the list to
 *     the engine must not silently drop the ability to paste a code.
 */

import { isWithheldOrganizationIdentifier } from '@/modules/shared/index.js';

import { DEFAULT_Q_MODE, type QMode } from './constants.js';
import {
  CPV_LEVELS,
  SEARCH_FACET_SIZE,
  type CpvLevelKey,
  type ProcurementGeoScope,
  type ProcurementSearchFilter,
  type SearchGrain,
  type SqlSearchSort,
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

/**
 * Analyzed name fields a `q` hit is highlighted in, per grain.
 *
 * Each is asked for twice, base and `.folded`, because the highlighter analyzes
 * the query with the FIELD's own analyzer: `title` does not fold diacritics, so
 * a reader searching `scoala` matched `Școala Gimnazială` through `title.folded`
 * and got a page with the record but no marks on it. Both sub-fields return the
 * ORIGINAL text, so either fragment renders identically.
 */
export const HIGHLIGHT_FIELDS: Readonly<Record<SearchGrain, readonly string[]>> = {
  procedures: ['title', 'authority_name'],
  contracts: ['title', 'authority_name', 'supplier_name'],
  direct_acquisitions: ['title', 'authority_name', 'supplier_name'],
  modifications: [],
};

/**
 * Highlight markers. NOT HTML: the client splits on these and renders its own
 * element, so a title containing `<mark>` \u2014 or any other markup \u2014 can never
 * become markup in the page.
 *
 * U+27E6/U+27E7 (mathematical white square brackets), verified absent from every
 * highlightable column of all three grains. Control characters were tried first
 * and are WRONG: the unified highlighter's fragment trimming eats a marker that
 * lands at the very start or end of a field, so `\u27E6Reparatii\u27E7 sisteme\u2026` came back
 * as `Reparatii\u27E7 sisteme\u2026` with the opening marker gone.
 */
export const HIGHLIGHT_OPEN = '\u27E6';
export const HIGHLIGHT_CLOSE = '\u27E7';

/**
 * Identifier keyword fields `q` also probes, per grain — the columns the SQL path
 * searched with `ILIKE` before the engine took over. Without these, pasting a
 * notice number into the search box returned NOTHING: `q="CAN1123309"` scored 0
 * hits through the analyzed name fields while `term(notice_no)` matched 30 docs.
 */
const IDENTIFIER_FIELDS: Readonly<Record<SearchGrain, readonly string[]>> = {
  procedures: ['notice_no'],
  contracts: ['notice_no', 'contract_no'],
  direct_acquisitions: ['unique_code'],
  modifications: [],
};

/** CUI keyword fields `q` probes when the query is all digits. */
const CUI_FIELDS: Readonly<Record<SearchGrain, readonly string[]>> = {
  procedures: ['authority_cui'],
  contracts: ['authority_cui', 'supplier_cui'],
  direct_acquisitions: ['authority_cui', 'supplier_cui'],
  modifications: [],
};

/**
 * An all-digit query, probed against the fiscal-code columns — unless the
 * kernel withholds that identifier.
 *
 * Over-10-digit identifiers are CNP-shaped natural-person identifiers, and the
 * platform contains them at the API (`isWithheldOrganizationIdentifier`,
 * shared kernel, P0 2026-07-22). MEASURED here, not assumed: of the canonical
 * contract facts, 408 distinct 13-digit supplier identifiers across 1,184 rows
 * are all CNP-shaped (leading digit 1–8) and belong to named natural persons.
 * Probing them would make a personal identification number a working query in
 * a public search box.
 *
 * So an unbounded digit probe is WRONG even though it costs only a dictionary
 * lookup, and even though it would otherwise find genuine padded/foreign codes
 * (68 records for `00041200627`). Those records remain reachable by title and
 * party name; only the identifier itself is withheld — the conservative side of
 * a privacy decision, which is where this platform puts it.
 */
const isProbeableCui = (token: string): boolean =>
  /^\d+$/u.test(token) && !isWithheldOrganizationIdentifier(token);

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
const sortField = (sort: SqlSearchSort): string =>
  sort === 'date_desc' || sort === 'date_asc' ? 'date_list' : 'value_comparable_bani';

/**
 * The analyzed-name matcher for one q-mode. `all` (the default) requires every
 * word; `any` is the original OR + typo tolerance, kept as the explicit "broaden
 * this" control; `phrase` requires the words adjacent and in order.
 */
const textClause = (q: string, mode: QMode): Clause => {
  const fields = [...Q_FIELDS];
  if (mode === 'phrase') return { multi_match: { query: q, fields, type: 'phrase' } };
  if (mode === 'any') {
    return {
      multi_match: {
        query: q,
        fields,
        type: 'best_fields',
        // ONE edit, not `AUTO`. AUTO allows two edits on a term of six letters
        // or more, and two edits reach a different word: `Mănuși` (gloves)
        // matched `MASURI` (measures) and returned 2,355 procedures where the
        // word itself has 863. At `fuzziness: 1` that query returns 865 — it
        // still finds the source's own misspelling `MASUSI`, and a real typo
        // still corrects (`medicamnte` → 31,379 hits, versus 5 with no
        // tolerance at all). `prefix_length: 2` keeps the first two letters
        // fixed so the expansion stays anchored to what was typed.
        fuzziness: '1',
        prefix_length: 2,
        max_expansions: 50,
      },
    };
  }
  return { multi_match: { query: q, fields, type: 'best_fields', operator: 'and' } };
};

/**
 * Exact keyword probes on the WHOLE query. These fields carry no normalizer, so
 * `can1123309` matches nothing while `CAN1123309` matches — the uppercase form is
 * therefore tried alongside the raw one. Boosted above a name match: a record
 * whose identifier IS the query outranks one that merely mentions the digits.
 *
 * No shape test: an earlier version required a single whitespace-free token, and
 * 264,588 real `contract_no` values contain a character that rejects (`5351 A`,
 * `970 APS`, `A - 2721`), so pasting one found nothing. A `term` on a keyword is
 * exact — a prose query simply misses the dictionary — so the probe costs a
 * lookup and can never widen the set beyond identifier equality.
 *
 * Deliberately EXACT where the SQL path was a substring `ILIKE '%q%'`. A prefix
 * query over a high-cardinality keyword is affordable here (`prefix notice_no
 * "CAN112"` = 60,236 hits in 15 ms) but it turns a paste of one code into tens of
 * thousands of neighbours, which is not what pasting a code means.
 */
const identifierClauses = (grain: SearchGrain, q: string): Clause[] => {
  const token = q.trim();
  const variants = [...new Set([token, token.toUpperCase()])];
  const out: Clause[] = [];
  for (const field of IDENTIFIER_FIELDS[grain]) {
    for (const value of variants) out.push({ term: { [field]: { value, boost: 8 } } });
  }
  // A CUI is the identity key of a party, not a word in a title: an exact match
  // on it answers "everything this institution/company signed", which is the
  // whole point of pasting one. `q="3897378"` used to return 7 incidental title
  // mentions while that buyer had 2,494 contracts.
  if (isProbeableCui(token)) {
    for (const field of CUI_FIELDS[grain]) {
      out.push({ term: { [field]: { value: token, boost: 12 } } });
    }
  }
  return out;
};

/**
 * The highlight block. Markers are control characters, not markup (see
 * `HIGHLIGHT_OPEN`). `require_field_match: false` so that a hit matched through
 * the diacritic-folded sub-field still marks the terms in the original text —
 * a reader searching `scoala` must see `Școala` marked.
 */
const highlightBlock = (grain: SearchGrain, q: string | undefined): Clause | undefined => {
  const fields = HIGHLIGHT_FIELDS[grain];
  if (q === undefined || fields.length === 0) return undefined;
  return {
    pre_tags: [HIGHLIGHT_OPEN],
    post_tags: [HIGHLIGHT_CLOSE],
    require_field_match: false,
    number_of_fragments: 1,
    fragment_size: 200,
    // 0 = a field with no match contributes nothing, rather than echoing its
    // whole value back as an unmarked "fragment".
    no_match_size: 0,
    fields: Object.fromEntries(
      fields.flatMap((field) => [
        [field, {}],
        [`${field}.folded`, {}],
      ])
    ),
  };
};

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

  // Names OR identifiers: one `should` group, so a code-shaped query reaches the
  // keyword fields the SQL path used to search without narrowing the name match.
  const must: Clause[] =
    filter.q === undefined
      ? []
      : [
          {
            bool: {
              should: [
                textClause(filter.q, filter.qMode ?? DEFAULT_Q_MODE),
                ...identifierClauses(grain, filter.q),
              ],
              minimum_should_match: 1,
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

  // `relevance` orders by BM25 with the numeric pk as the tiebreak — total
  // within a response, and stable across pages of one immutable single-shard
  // generation (verified: pages 1+2 equal a single 40-document window, no
  // repeat, no gap across tied scores). See parity rule 7 for what a reshard
  // would break.
  const sort: Clause[] =
    page.sort === 'relevance'
      ? [{ _score: 'desc' }, { pk: 'desc' }]
      : [
          { [sortField(page.sort)]: { order: ascending ? 'asc' : 'desc', missing: '_last' } },
          { pk: 'desc' },
        ];

  const highlight = highlightBlock(grain, filter.q);

  return {
    body: {
      from: (page.page - 1) * page.pageSize,
      size: page.pageSize,
      _source: false,
      track_total_hits: trackTotalHits,
      query: { bool: { ...(must.length > 0 && { must }), filter: filters } },
      sort,
      ...(highlight !== undefined && { highlight }),
      ...(facetDims.length > 0 && { aggs }),
    },
    facetDims,
  };
};
