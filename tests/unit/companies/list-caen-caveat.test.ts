/**
 * Companies unit tests — the directory list's CAEN class-only disclosure
 * (CQA-15). Registry CAEN criteria test qualified class observations only, and
 * a CAEN exclusion also needs complete CAEN coverage. Every list an effective
 * CAEN criterion shapes says so; an empty field compiles to no predicate and
 * earns no disclosure.
 */

import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { CAEN_CLASS_LIST_CAVEAT, makeCompanyList } from '@/modules/companies/core/usecases.js';

import { stubFlows, stubRepo } from './repo-fixtures.js';

import type { FilterInput } from '@/modules/shared/index.js';

const caveatsFor = async (filter: FilterInput): Promise<readonly string[]> => {
  const listCompanies = vi.fn(async () => ok({ rows: [], total: 0, estimated: false }));
  const res = await makeCompanyList(
    { repo: stubRepo({ listCompanies }), flowsRepo: stubFlows(), meili: null },
    { filter, sort: 'name', page: { page: 1, pageSize: 20 } }
  );
  return res._unsafeUnwrap().caveats;
};

describe('the directory list CAEN class-only disclosure (CQA-15)', () => {
  it.each([
    ['a broad code', { caenCode: { eq: '6201' } }],
    ['a broad prefix', { caenCode: { prefix: '62' } }],
    ['an exact key', { onrcCaen: { eq: 'rev2:6201' } }],
    ['a broad exclusion', { exclude: { caenCode: { eq: '0201' } } }],
    ['an exact exclusion', { exclude: { onrcCaen: { eq: 'rev2:0201' } } }],
    ['a numeric eq', { caenCode: { eq: 6201 } }],
  ])('%s discloses it once', async (_name, filter) => {
    const caveats = await caveatsFor(filter);
    expect(caveats.filter((c) => c === CAEN_CLASS_LIST_CAVEAT)).toHaveLength(1);
  });

  it.each([
    ['no filter', {}],
    ['an empty broad criterion', { caenCode: {} }],
    ['an empty exact exclusion', { exclude: { onrcCaen: {} } }],
    ['a prefix on onrcCaen (not an onrcCaen operator)', { onrcCaen: { prefix: 'rev2' } }],
    ['a string under in', { caenCode: { in: '6201' } }],
    ['an array under eq', { caenCode: { eq: ['6201'] } }],
    ['an array under prefix', { caenCode: { prefix: ['62'] } }],
    ['a string under an exclusion in', { exclude: { caenCode: { in: '0201' } } }],
    ['an array under an exact exclusion eq', { exclude: { onrcCaen: { eq: ['rev2:0201'] } } }],
    [
      'a status criterion and exclusion',
      { status: { eq: '1048' }, exclude: { status: { eq: '1070' } } },
    ],
  ])('%s: no CAEN disclosure', async (_name, filter) => {
    expect(await caveatsFor(filter as FilterInput)).not.toContain(CAEN_CLASS_LIST_CAVEAT);
  });
});
