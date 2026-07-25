/**
 * The compiled OpenSearch list query — the engine's half of the list contract.
 *
 * These tests pin the rules that must not drift from the SQL path: the date
 * and value fields the filters bind to, NULLS-LAST ordering, the numeric pk
 * tiebreak, CPV level precedence, and the "explicit empty list matches
 * nothing" rule.
 */

import { describe, expect, it } from 'vitest';

import { compileListQuery, ronToBani } from '@/modules/procurement/core/opensearch-query.js';

import type { OffsetSearchRequest } from '@/modules/procurement/core/types.js';

const page: OffsetSearchRequest = { page: 1, pageSize: 20, sort: 'date_desc' };

const filtersOf = (body: Record<string, unknown>): Record<string, unknown>[] => {
  const query = body['query'] as { bool: { filter: Record<string, unknown>[] } };
  return query.bool.filter;
};

describe('compileListQuery — field bindings', () => {
  it('binds date filters and date sorts to the grain OWN date, not date_basis', () => {
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: { dateRange: { gte: '2024-01-01', lte: '2024-12-31' } },
      page,
    });
    expect(filtersOf(body)).toContainEqual({
      range: { date_list: { gte: '2024-01-01', lte: '2024-12-31' } },
    });
    expect(body['sort']).toEqual([
      { date_list: { order: 'desc', missing: '_last' } },
      { pk: 'desc' },
    ]);
  });

  it('binds value filters and value sorts to the RESOLVED comparable measure', () => {
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: { valueRon: { gte: '1000', lte: '50000.50' } },
      page: { ...page, sort: 'value_asc' },
    });
    expect(filtersOf(body)).toContainEqual({
      range: { value_comparable_bani: { gte: 100_000, lte: 5_000_050 } },
    });
    expect(body['sort']).toEqual([
      { value_comparable_bani: { order: 'asc', missing: '_last' } },
      { pk: 'desc' },
    ]);
  });

  it('windows the page exactly like the SQL OFFSET', () => {
    const { body } = compileListQuery({
      grain: 'procedures',
      filter: {},
      page: { page: 4, pageSize: 25, sort: 'date_desc' },
    });
    expect(body['from']).toBe(75);
    expect(body['size']).toBe(25);
  });
});

describe('compileListQuery — predicates', () => {
  it('compiles both geography sides as AND-ed terms', () => {
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: {
        buyerGeo: { countyCode: 'CJ' },
        supplierGeo: { region: 'Bucuresti-Ilfov', siruta: '179150' },
      },
      page,
    });
    const filters = filtersOf(body);
    expect(filters).toContainEqual({ term: { buyer_county_code: 'CJ' } });
    expect(filters).toContainEqual({ term: { supplier_region: 'Bucuresti-Ilfov' } });
    expect(filters).toContainEqual({ term: { supplier_siruta: '179150' } });
  });

  it('prefers the finest CPV level and compiles it as a prefix', () => {
    const group = compileListQuery({
      grain: 'contracts',
      filter: { cpvGroup: '45200000' },
      page,
    });
    expect(filtersOf(group.body)).toContainEqual({ prefix: { cpv_code: '452' } });

    const both = compileListQuery({
      grain: 'contracts',
      filter: { cpvGroup: '45200000', cpvCategory: '45233000' },
      page,
    });
    expect(filtersOf(both.body)).toContainEqual({ prefix: { cpv_code: '45233' } });

    const exact = compileListQuery({
      grain: 'contracts',
      filter: { cpvCode: '45233140', cpvCategory: '45233000', cpvDivision: '45' },
      page,
    });
    expect(filtersOf(exact.body)).toContainEqual({ term: { cpv_code: '45233140' } });
    expect(filtersOf(exact.body)).toHaveLength(1);
  });

  it('an explicit empty `in` matches nothing (never a dropped predicate)', () => {
    const { body } = compileListQuery({ grain: 'contracts', filter: { status: [] }, page });
    expect(filtersOf(body)).toContainEqual({ terms: { status: [] } });
  });

  it('applies recordKind only on the contracts grain', () => {
    const contracts = compileListQuery({
      grain: 'contracts',
      filter: { recordKind: ['framework_agreement'] },
      page,
    });
    expect(filtersOf(contracts.body)).toContainEqual({
      terms: { record_kind: ['framework_agreement'] },
    });
    const das = compileListQuery({
      grain: 'direct_acquisitions',
      filter: { recordKind: ['framework_agreement'] },
      page,
    });
    expect(filtersOf(das.body)).toHaveLength(0);
  });

  it('puts free text in `must` (scored) and structured filters in filter context', () => {
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: { q: 'reparatii drumuri', status: ['awarded'] },
      page,
    });
    const query = body['query'] as { bool: Record<string, unknown> };
    expect(Array.isArray(query.bool['must'])).toBe(true);
    expect(filtersOf(body)).toEqual([{ terms: { status: ['awarded'] } }]);
  });
});

// ── free text: modes, identifiers, relevance, highlight ───────────────────────

/** The `should` group inside `must` — the names-OR-identifiers matcher. */
const textShoulds = (body: Record<string, unknown>): Record<string, unknown>[] => {
  const query = body['query'] as {
    bool: { must?: { bool: { should: Record<string, unknown>[] } }[] };
  };
  return query.bool.must?.[0]?.bool.should ?? [];
};

describe('compileListQuery — q modes', () => {
  it('defaults to "every word must appear"', () => {
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: { q: 'drumuri comunale' },
      page,
    });
    const [text] = textShoulds(body);
    expect(text?.['multi_match']).toMatchObject({ type: 'best_fields', operator: 'and' });
    // The default must NOT be fuzzy: on the live index `fuzziness: AUTO` took
    // `reparatii drumuri comunale` from 30,667 hits to 90,872.
    expect(text?.['multi_match']).not.toHaveProperty('fuzziness');
  });

  it('reads `any` as the broad OR + typo tolerance, and `phrase` as adjacency', () => {
    const anyBody = compileListQuery({
      grain: 'contracts',
      filter: { q: 'drumuri comunale', qMode: 'any' },
      page,
    }).body;
    expect(textShoulds(anyBody)[0]?.['multi_match']).toMatchObject({
      type: 'best_fields',
      // ONE edit: `AUTO` allows two on a 6-letter term, and two edits reach a
      // different word — `Mănuși` matched `MASURI` (2,355 hits vs 863).
      fuzziness: '1',
      prefix_length: 2,
    });
    const phraseBody = compileListQuery({
      grain: 'contracts',
      filter: { q: 'drumuri comunale', qMode: 'phrase' },
      page,
    }).body;
    expect(textShoulds(phraseBody)[0]?.['multi_match']).toMatchObject({ type: 'phrase' });
  });
});

describe('compileListQuery — identifiers in q', () => {
  it('probes the grain identifier keywords, uppercased, for a code-shaped query', () => {
    // `q="CAN1123309"` scored 0 hits through the analyzed name fields while
    // `term(notice_no)` matched 30 documents — the SQL path searched these
    // columns and the engine must not lose them.
    const { body } = compileListQuery({ grain: 'contracts', filter: { q: 'can1123309' }, page });
    const shoulds = textShoulds(body);
    expect(shoulds).toContainEqual({ term: { notice_no: { value: 'CAN1123309', boost: 8 } } });
    expect(shoulds).toContainEqual({ term: { contract_no: { value: 'CAN1123309', boost: 8 } } });
    // The raw form too: these keyword fields carry no normalizer.
    expect(shoulds).toContainEqual({ term: { notice_no: { value: 'can1123309', boost: 8 } } });
  });

  it('NEVER probes a CNP-shaped identifier — that is personal data', () => {
    // 408 distinct 13-digit supplier identifiers across 1,184 canonical rows
    // are CNP-shaped and belong to named natural persons. The kernel withholds
    // over-10-digit identifiers (P0 containment); probing one here would make a
    // personal identification number a working query in a public search box.
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: { q: '1850101070016' },
      page,
    });
    const fields = textShoulds(body).flatMap((clause) =>
      clause['term'] === undefined ? [] : Object.keys(clause['term'] as object)
    );
    expect(fields).not.toContain('supplier_cui');
    expect(fields).not.toContain('authority_cui');
    // It is still an identifier-shaped token, so the notice/contract probes
    // stay — they carry no personal data.
    expect(fields).toContain('notice_no');
  });

  it('probes both CUIs for an all-digits query, above a name match', () => {
    const { body } = compileListQuery({ grain: 'contracts', filter: { q: '3897378' }, page });
    const shoulds = textShoulds(body);
    expect(shoulds).toContainEqual({ term: { authority_cui: { value: '3897378', boost: 12 } } });
    expect(shoulds).toContainEqual({ term: { supplier_cui: { value: '3897378', boost: 12 } } });
    // A digits query is also a valid contract_no, so that probe stays.
    expect(shoulds).toContainEqual({ term: { contract_no: { value: '3897378', boost: 8 } } });
  });

  it('never probes a supplier CUI on procedures — a procedure predates its award', () => {
    const { body } = compileListQuery({ grain: 'procedures', filter: { q: '3897378' }, page });
    const fields = textShoulds(body).flatMap((clause) =>
      clause['term'] === undefined ? [] : Object.keys(clause['term'] as object)
    );
    expect(fields).toContain('authority_cui');
    expect(fields).not.toContain('supplier_cui');
    expect(fields).not.toContain('contract_no');
  });

  it('probes a code that contains a space — 264,588 real contract numbers do', () => {
    // `5351 A`, `970 APS`, `A - 2721`. An earlier shape test required a single
    // whitespace-free token and made every one of them unfindable.
    const { body } = compileListQuery({ grain: 'contracts', filter: { q: '5351 a' }, page });
    expect(textShoulds(body)).toContainEqual({
      term: { contract_no: { value: '5351 A', boost: 8 } },
    });
  });

  it('costs a prose query nothing but a dictionary miss', () => {
    // The probe is exact, so `servicii de paza` cannot widen the result set
    // through it — but it is still compiled, because a shape test is what
    // broke the codes with spaces.
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: { q: 'servicii de paza' },
      page,
    });
    const fields = textShoulds(body).flatMap((clause) =>
      clause['term'] === undefined ? [] : Object.keys(clause['term'] as object)
    );
    expect(fields).toEqual(['notice_no', 'notice_no', 'contract_no', 'contract_no']);
  });
});

describe('compileListQuery — relevance and highlight', () => {
  it('orders by score with the pk tiebreak, keeping the order TOTAL', () => {
    const { body } = compileListQuery({
      grain: 'contracts',
      filter: { q: 'spital' },
      page: { ...page, sort: 'relevance' },
    });
    expect(body['sort']).toEqual([{ _score: 'desc' }, { pk: 'desc' }]);
  });

  it('asks for fragments only when there is a query to highlight', () => {
    const withQ = compileListQuery({ grain: 'contracts', filter: { q: 'spital' }, page }).body;
    expect(withQ['highlight']).toMatchObject({
      // Sentinels, not markup: the client renders its own element. Control
      // characters do NOT work here \u2014 the highlighter trims one that lands at
      // the very start or end of a field.
      pre_tags: ['\u27E6'],
      post_tags: ['\u27E7'],
      require_field_match: false,
    });
    const withoutQ = compileListQuery({ grain: 'contracts', filter: {}, page }).body;
    expect(withoutQ['highlight']).toBeUndefined();
  });

  it('highlights only the name fields a grain actually has, through both analyzers', () => {
    // `.folded` too: the highlighter analyzes the query with the FIELD's
    // analyzer, and `title` does not fold diacritics — a reader searching
    // `scoala` matched `Școala Gimnazială` and got no marks without this.
    const { body } = compileListQuery({ grain: 'procedures', filter: { q: 'spital' }, page });
    const highlight = body['highlight'] as { fields: Record<string, unknown> };
    expect(Object.keys(highlight.fields)).toEqual([
      'title',
      'title.folded',
      'authority_name',
      'authority_name.folded',
    ]);
  });
});

describe('compileListQuery — facets', () => {
  it('compiles requested dimensions to terms aggregations', () => {
    const { body, facetDims } = compileListQuery({
      grain: 'contracts',
      filter: {},
      page,
      facets: ['buyerCounty', 'status'],
    });
    expect(facetDims).toEqual(['buyerCounty', 'status']);
    expect(body['aggs']).toEqual({
      buyerCounty: { terms: { field: 'buyer_county_code', size: 30 } },
      status: { terms: { field: 'status', size: 30 } },
    });
  });

  it('omits the aggs block entirely when no facets are requested', () => {
    const { body, facetDims } = compileListQuery({ grain: 'contracts', filter: {}, page });
    expect(body['aggs']).toBeUndefined();
    expect(facetDims).toEqual([]);
  });
});

describe('ronToBani', () => {
  it('converts exact 2-decimal money without floats', () => {
    expect(ronToBani('0', 'gte')).toBe(0);
    expect(ronToBani('1234.56', 'gte')).toBe(123_456);
    expect(ronToBani('1234.56', 'lte')).toBe(123_456);
    expect(ronToBani('-5.25', 'lte')).toBe(-525);
  });

  it('narrows sub-bani bounds instead of admitting a row Postgres excludes', () => {
    // value ≥ 100.005 excludes a 100.00 row; value ≤ 100.005 includes it.
    expect(ronToBani('100.005', 'gte')).toBe(10_001);
    expect(ronToBani('100.005', 'lte')).toBe(10_000);
    expect(ronToBani('-100.005', 'gte')).toBe(-10_000);
    expect(ronToBani('-100.005', 'lte')).toBe(-10_001);
  });

  it('carries a bound beyond safe-integer range EXACTLY, as a string', () => {
    // Rounding such a bound to a float would move it outward and admit rows
    // Postgres excludes; `long` range clauses accept the exact digits as text.
    expect(ronToBani('999999999999999999999', 'gte')).toBe('99999999999999999999900');
    expect(ronToBani('92233720368.54', 'lte')).toBe(9223372036854);
  });
});
