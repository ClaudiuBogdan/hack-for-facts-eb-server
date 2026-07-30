import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeClickhouseAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import { compactResponse } from './clickhouse-response.js';

import type { AnalysisRoute } from '@/modules/procurement/core/combinations.js';
import type { AnalysisRepo } from '@/modules/procurement/core/ports.js';

const activeGeneration: AnalysisRepo['activeGeneration'] = () =>
  Promise.reject(new Error('activeGeneration is not used by these tests'));

const route: AnalysisRoute = { grain: 'contract' };

const statsRow = {
  rows: '127644',
  with_value: '118327',
  with_estimated: '0',
  awarded_bani_out: '10359462688440',
  estimated_bani_out: null,
  ceiling_bani_out: null,
  mod_adjusted_bani_out: null,
  awarded_matched_bani_out: null,
  min_month: '2025-01',
  max_month: '2025-12',
  undated_count: '0',
  undated_bani_out: null,
  withheld_bani_out: null,
};

const makeRepo = (): AnalysisRepo =>
  makeClickhouseAnalysisRepo(
    { url: 'http://clickhouse.test', database: 'proto' },
    activeGeneration
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClickHouse JSONCompact transport', () => {
  it('maps compact columns back to the named analysis row', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(compactResponse([statsRow]));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await makeRepo().statsFor(route, { year: 2025 }, '1');

    expect(result._unsafeUnwrap()).toMatchObject({
      rows: '127644',
      withValue: '118327',
      valueAwardedSum: '103594626884.40',
      minMonth: '2025-01',
      maxMonth: '2025-12',
    });
    const body = (fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined)?.body;
    expect(body?.endsWith('FORMAT JSONCompact')).toBe(true);
  });

  it('fails closed when a compact row does not match its metadata', async () => {
    const names = Object.keys(statsRow);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          meta: names.map((name) => ({ name, type: 'String' })),
          data: [names.slice(1).map((name) => statsRow[name as keyof typeof statsRow])],
        })
      )
    );

    const result = await makeRepo().statsFor(route, {}, '1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('malformed JSONCompact row');
  });

  it('rejects a full-width row with a wrong column name', async () => {
    const names = Object.keys(statsRow);
    const wrongNames = names.map((name) => (name === 'rows' ? 'rowz' : name));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          meta: wrongNames.map((name) => ({ name, type: 'String' })),
          data: [names.map((name) => statsRow[name as keyof typeof statsRow])],
        })
      )
    );

    const result = await makeRepo().statsFor(route, {}, '1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('unexpected JSONCompact columns');
  });

  it('rejects duplicate compact column names', async () => {
    const names = Object.keys(statsRow);
    const duplicateNames = names.map((name, index) =>
      index === names.length - 1 ? names[0] : name
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          meta: duplicateNames.map((name) => ({ name, type: 'String' })),
          data: [names.map((name) => statsRow[name as keyof typeof statsRow])],
        })
      )
    );

    const result = await makeRepo().statsFor(route, {}, '1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('duplicate JSONCompact column names');
  });

  it('rejects wrong scalar types before money conversion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(compactResponse([{ ...statsRow, awarded_bani_out: 123 }]))
    );

    const result = await makeRepo().statsFor(route, {}, '1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('invalid JSONCompact row');
  });

  it('coalesces concurrent identical reads into one HTTP request', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchSpy = vi.fn().mockReturnValue(response);
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeRepo();

    const first = repo.statsFor(route, { year: 2025 }, '1');
    const second = repo.statsFor(route, { year: 2025 }, '1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveResponse?.(compactResponse([statsRow]));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult._unsafeUnwrap()).toEqual(secondResult._unsafeUnwrap());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('clears a failed shared flight so the next read can retry', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(compactResponse([{ ...statsRow, rows: 'not-a-count' }]))
      .mockResolvedValueOnce(compactResponse([statsRow]));
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeRepo();

    const [first, second] = await Promise.all([
      repo.statsFor(route, { year: 2025 }, '1'),
      repo.statsFor(route, { year: 2025 }, '1'),
    ]);
    const retry = await repo.statsFor(route, { year: 2025 }, '1');

    expect(first.isErr()).toBe(true);
    expect(second.isErr()).toBe(true);
    expect(retry._unsafeUnwrap().rows).toBe('127644');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps Float64 basis coverage as a number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        compactResponse([
          {
            grain: 'contract',
            basis: 'estimated',
            population: 'applicable_canonical',
            coverage: 0.975,
          },
        ])
      )
    );

    const rows = (await makeRepo().basisCoverage('1'))._unsafeUnwrap();

    expect(rows).toEqual([
      {
        grain: 'contract',
        basis: 'estimated',
        population: 'applicable_canonical',
        coverage: 0.975,
      },
    ]);
    expect(typeof rows[0]?.coverage).toBe('number');
  });

  it('accepts a signed unknown-supplier monetary measure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(compactResponse([statsRow]))
        .mockResolvedValueOnce(
          compactResponse([
            {
              supplier_count: '1',
              positive_supplier_count: '1',
              measure_total: '1000',
              top1_measure: '1000',
              top5_measure: '1000',
              measure_squared_sum: '1000000',
              unknown_measure: '-123',
            },
          ])
        )
    );

    const result = await makeRepo().concentrationFor(route, { year: 2025 }, '1', 'value');

    expect(result._unsafeUnwrap().unknownSupplierMeasure).toBe('-1.23');
  });
});
