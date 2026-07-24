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

  it('keeps an absurd bound a valid query (clamped, same result set)', () => {
    expect(Number.isSafeInteger(ronToBani('999999999999999999999', 'gte'))).toBe(true);
  });
});
