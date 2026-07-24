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

describe('ClickHouse row-filter and dimension scope compilation', () => {
  const statsBody = async (scope: Parameters<AnalysisRepo['statsFor']>[1]): Promise<string> => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStatsResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );
    const result = await repo.statsFor(route('contract'), scope, '1');
    expect(result.isOk()).toBe(true);
    const request = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
    return request?.body ?? '';
  };

  it('filters contracts by record_kind equality', async () => {
    const body = await statsBody({ recordKind: 'framework_agreement' });
    expect(body).toContain("record_kind = 'framework_agreement'");
  });

  it('compiles CPV level scopes as cpv_code prefix matches at the level length', async () => {
    expect(await statsBody({ cpvGroup: '45200000' })).toContain(
      "startsWith(ifNull(cpv_code, ''), '452')"
    );
    expect(await statsBody({ cpvClass: '45230000' })).toContain(
      "startsWith(ifNull(cpv_code, ''), '4523')"
    );
    expect(await statsBody({ cpvCategory: '45233000' })).toContain(
      "startsWith(ifNull(cpv_code, ''), '45233')"
    );
  });

  it('compiles q as a case-insensitive title predicate with escaping', async () => {
    const body = await statsBody({ q: "drum judetean 'DJ'" });
    expect(body).toContain(
      "positionCaseInsensitiveUTF8(ifNull(title, ''), 'drum judetean \\'DJ\\'') > 0"
    );
  });

  it('compiles value bounds as accepted-set bani predicates', async () => {
    const body = await statsBody({ valueMin: 1000.5, valueMax: 5_000_000 });
    expect(body).toContain("value_state IN ('official_exact', 'official_ron_equivalent')");
    expect(body).toContain('value_awarded_bani >= 100050');
    expect(body).toContain('value_awarded_bani <= 500000000');
  });

  it('keeps value bounds at the top level of a bounded window (undated rows filtered too)', async () => {
    const body = await statsBody({ valueMin: 1000, year: 2025 });
    // Row filters precede the dated/undated OR-composition: they constrain the
    // WHOLE population, including the undated bucket — not just dated rows.
    expect(body).toContain(
      "value_awarded_bani >= 100000 AND ((NOT is_undated AND date_basis >= toDate('2025-01-01') AND date_basis < toDate('2026-01-01')) OR is_undated)"
    );
  });

  it('exact bani conversion (binary float 1.05 RON compiles to 105 bani)', async () => {
    const body = await statsBody({ valueMin: 1.05 });
    expect(body).toContain('value_awarded_bani >= 105');
  });

  it('keys CPV level breakdowns on canonical 8-digit codes and honors SIRUTA topN', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(emptyStatsResponse())
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo(
      { url: 'http://clickhouse.test', database: 'proto' },
      activeGeneration
    );

    const result = await repo.breakdownFor(route('contract'), {}, '1', 'cpvGroup', 3300, 'count');

    expect(result.isOk()).toBe(true);
    const topBody = (fetchSpy.mock.calls[1]?.[1] as { body?: string } | undefined)?.body ?? '';
    // Canonical 8-digit group keys; coarser-level codes (zero group digit,
    // e.g. a bare division 45000000) fall to NULL → the unknown bucket.
    expect(topBody).toContain(
      "if(length(cpv_code) = 8 AND substring(cpv_code, 3, 1) != '0', concat(substring(cpv_code, 1, 3), '00000'), NULL) AS key"
    );
    expect(topBody).toContain('LIMIT 3300');
  });
});
