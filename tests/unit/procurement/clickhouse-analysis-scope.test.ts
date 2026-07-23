import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeClickhouseAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import type { AnalysisRoute } from '@/modules/procurement/core/combinations.js';
import type { AnalysisRepo } from '@/modules/procurement/core/ports.js';

const route = (grain: AnalysisRoute['grain']): AnalysisRoute => ({ grain });

const activeGeneration: AnalysisRepo['activeGeneration'] = () =>
  Promise.reject(new Error('activeGeneration is not used by these tests'));

const emptyStatsResponse = (): Response =>
  Response.json({
    data: [
      {
        rows: '0',
        with_value: '0',
        with_estimated: '0',
        awarded_bani_out: null,
        estimated_bani_out: null,
        min_month: null,
        max_month: null,
        undated_count: '0',
        undated_bani_out: null,
      },
    ],
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClickHouse procurement SIRUTA scope compilation', () => {
  it('filters contract analytics by supplier UAT SIRUTA', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('contract'), { supplierSiruta: '057706' }, '1');

    expect(result.isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request?.body).toContain('supplier_siruta_uat = 57706');
  });

  it('rejects non-numeric supplier SIRUTA without querying ClickHouse', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('contract'), { supplierSiruta: 'CJ' }, '1');

    expect(result._unsafeUnwrap().rows).toBe('0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats supplier SIRUTA as structurally unavailable on procedures', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.statsFor(route('procedure'), { supplierSiruta: '57706' }, '1');

    expect(result._unsafeUnwrap().rows).toBe('0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
