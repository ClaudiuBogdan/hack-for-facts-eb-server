/**
 * Two defects of the ClickHouse analysis repo, asserted on the SQL it actually
 * generates and on the read it actually returns:
 *
 *  1. BOUNDED-PERIOD KEY LEAKAGE. A bounded scope deliberately keeps undated
 *     rows in `where` (they feed the undated disclosure counts) while `dated`
 *     drives every period measure. Grouping on `where` alone therefore lets a
 *     dimension key represented ONLY by undated rows take a top-N slot as a
 *     zero-record bucket, and inflates the concentration's distinct-supplier
 *     count. Live case: CUI 23533797 under authorityCui=36727850, 2025 — one
 *     undated row, zero dated rows.
 *
 *  2. HONEST VALUE RANKING. When no record in scope carries an accepted value
 *     on the breakdown's money basis, a value ORDER BY sorts an all-zero tie.
 *     The repo re-ranks by record count BEFORE the top-N cut and reports
 *     `rankedBy: 'count'` — never a relabeling of a value-limited population.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeClickhouseAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import type { AnalysisRoute } from '@/modules/procurement/core/combinations.js';
import type { AnalysisRepo } from '@/modules/procurement/core/ports.js';

const route = (grain: AnalysisRoute['grain']): AnalysisRoute => ({ grain });

const activeGeneration: AnalysisRepo['activeGeneration'] = () =>
  Promise.reject(new Error('activeGeneration is not used by these tests'));

/** The exact dated predicate `compileScope` emits for the 2025 window. */
const DATED_2025 =
  "(NOT is_undated AND date_basis >= toDate('2025-01-01') AND date_basis < addMonths(toDate('2025-12-01'), 1))";

/** The 2025 institution scope from the live reproduction. */
const SCOPE_2025: AnalysisScope = {
  authorityCui: '36727850',
  from: '2025-01',
  to: '2025-12',
};

const statsResponse = (over: Record<string, unknown> = {}): Response =>
  Response.json({
    data: [
      {
        rows: '26',
        with_value: '0',
        with_estimated: '0',
        awarded_bani_out: null,
        estimated_bani_out: null,
        ceiling_bani_out: null,
        mod_adjusted_bani_out: null,
        awarded_matched_bani_out: null,
        min_month: '2025-01',
        max_month: '2025-12',
        undated_count: '1',
        undated_bani_out: null,
        withheld_bani_out: '2226299608300',
        ...over,
      },
    ],
  });

const concentrationResponse = (over: Record<string, unknown> = {}): Response =>
  Response.json({
    data: [
      {
        supplier_count: '0',
        positive_supplier_count: '0',
        measure_total: '0',
        top1_measure: '0',
        top5_measure: '0',
        measure_squared_sum: '0',
        unknown_measure: '0',
        ...over,
      },
    ],
  });

const bodies = (spy: ReturnType<typeof vi.fn>): readonly string[] =>
  spy.mock.calls.map((call) => (call[1] as { body?: string } | undefined)?.body ?? '');

const makeRepo = (spy: ReturnType<typeof vi.fn>): AnalysisRepo => {
  vi.stubGlobal('fetch', spy);
  return makeClickhouseAnalysisRepo(
    { url: 'http://clickhouse.test', database: 'proto' },
    activeGeneration
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bounded-period dimension keys (breakdown)', () => {
  it('requires at least one DATED row per key, so undated-only keys take no top-N slot', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(statsResponse())
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);

    const result = await repo.breakdownFor(
      route('contract'),
      SCOPE_2025,
      '1',
      'supplier',
      10,
      'value'
    );

    expect(result.isOk()).toBe(true);
    const topBody = bodies(spy)[2] ?? '';
    expect(topBody).toContain('GROUP BY key');
    // The guard counts DATED rows, not value-bearing ones: a dated key with no
    // accepted money is a legitimate count answer and must survive.
    expect(topBody).toContain(`HAVING countIf(${DATED_2025}) > 0`);
    expect(topBody).not.toContain(`HAVING countIf(${DATED_2025} AND value_awarded`);
  });

  it('keeps undated rows in the row-selection predicate (disclosure counts stay whole)', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(statsResponse())
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);
    await repo.breakdownFor(route('contract'), SCOPE_2025, '1', 'supplier', 10, 'value');

    for (const body of bodies(spy)) {
      expect(body).toContain(`(${DATED_2025} OR is_undated)`);
    }
    // The undated bucket still reports on the WHOLE scope, dated or not.
    expect(bodies(spy)[0]).toContain('toString(countIf(is_undated)) AS undated_count');
  });

  it('emits NO dated guard for an unbounded scope (all-time semantics unchanged)', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(statsResponse())
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);
    await repo.breakdownFor(
      route('contract'),
      { authorityCui: '36727850' },
      '1',
      'supplier',
      10,
      'value'
    );

    expect(bodies(spy)[2]).not.toContain('HAVING');
  });

  it('returns dated keys that carry no accepted money (count-capable buckets)', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(statsResponse())
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(
        Response.json({ data: [{ key: '23533797', cnt: '4', wv: '0', awarded_bani: '0' }] })
      );
    const repo = makeRepo(spy);

    const read = (
      await repo.breakdownFor(route('contract'), SCOPE_2025, '1', 'supplier', 10, 'value')
    )._unsafeUnwrap();

    const top = read.buckets.filter((bucket) => bucket.kind === 'top');
    expect(top).toHaveLength(1);
    expect(top[0]?.key).toBe('23533797');
    expect(top[0]?.recordCount).toBe('4');
  });
});

describe('bounded-period supplier keys (concentration)', () => {
  it('excludes undated-only suppliers from the distinct-supplier rows', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(statsResponse())
      .mockResolvedValueOnce(concentrationResponse());
    const repo = makeRepo(spy);

    const result = await repo.concentrationFor(route('contract'), SCOPE_2025, '1', 'value');

    expect(result.isOk()).toBe(true);
    const rowsBody = bodies(spy)[1] ?? '';
    expect(rowsBody).toContain('GROUP BY supplier_key');
    expect(rowsBody).toContain(`HAVING countIf(${DATED_2025}) > 0`);
  });

  it('emits NO dated guard for an unbounded concentration scope', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(statsResponse())
      .mockResolvedValueOnce(concentrationResponse());
    const repo = makeRepo(spy);
    await repo.concentrationFor(route('contract'), { authorityCui: '36727850' }, '1', 'value');

    expect(bodies(spy)[1]).not.toContain('HAVING');
  });

  it('returns one exact aggregate row, including zero-basis suppliers', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(statsResponse())
      .mockResolvedValueOnce(
        concentrationResponse({ supplier_count: '2', positive_supplier_count: '0' })
      );
    const repo = makeRepo(spy);

    const read = (
      await repo.concentrationFor(route('contract'), SCOPE_2025, '1', 'value')
    )._unsafeUnwrap();

    expect(read.supplierCount).toBe(2);
    expect(read.positiveSupplierCount).toBe(0);
    expect(read.measureTotal).toBe('0.00');
    expect(read.measureSquaredSum).toBe('0.0000');
    expect(read.unknownSupplierMeasure).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bodies(spy)[1]).toContain('AS measure_squared_sum');
  });
});

describe('honest value-ranking fallback (breakdown)', () => {
  const withValue = (n: string, over: Record<string, unknown> = {}): Response =>
    statsResponse({ with_value: n, ...over });

  it('re-ranks by record count BEFORE the top-N when no row carries value', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(withValue('0'))
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);

    const read = (
      await repo.breakdownFor(route('contract'), SCOPE_2025, '1', 'supplier', 10, 'value')
    )._unsafeUnwrap();

    expect(read.rankedBy).toBe('count');
    const topBody = bodies(spy)[2] ?? '';
    expect(topBody).toContain(`ORDER BY countIf(${DATED_2025}) DESC, key ASC`);
    expect(topBody).not.toContain('ORDER BY ifNull(sumIf(');
    // The LIMIT is applied to the count-ranked order, not to a value-ranked one.
    expect(topBody.indexOf('ORDER BY countIf(')).toBeLessThan(topBody.indexOf('LIMIT'));
  });

  it('keeps the value ranking when value-bearing rows exist in scope', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(withValue('5', { awarded_bani_out: '2226299608300' }))
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);

    const read = (
      await repo.breakdownFor(route('contract'), SCOPE_2025, '1', 'authority', 10, 'value')
    )._unsafeUnwrap();

    expect(read.rankedBy).toBe('value');
    expect(bodies(spy)[2]).toContain('ORDER BY ifNull(sumIf(');
  });

  it('falls back when every value-bearing row lands in the unknown bucket', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(withValue('5', { awarded_bani_out: '2226299608300' }))
      // All five valued rows have a NULL dimension key → no named bucket can
      // carry money, so a value ORDER BY over the named keys is still a tie.
      .mockResolvedValueOnce(
        Response.json({ data: [{ cnt: '5', wv: '5', awarded_bani: '2226299608300' }] })
      )
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);

    const read = (
      await repo.breakdownFor(route('contract'), SCOPE_2025, '1', 'cpvDivision', 10, 'value')
    )._unsafeUnwrap();

    expect(read.rankedBy).toBe('count');
    expect(bodies(spy)[2]).toContain('ORDER BY countIf(');
  });

  it('reports count ranking for an explicit count request', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(withValue('5', { awarded_bani_out: '2226299608300' }))
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);

    const read = (
      await repo.breakdownFor(route('contract'), SCOPE_2025, '1', 'authority', 10, 'count')
    )._unsafeUnwrap();

    expect(read.rankedBy).toBe('count');
  });

  it('reports count ranking on the counts-only modification grain', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(withValue('0'))
      .mockResolvedValueOnce(Response.json({ data: [{ cnt: '0', wv: '0', awarded_bani: '0' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const repo = makeRepo(spy);

    const read = (
      await repo.breakdownFor(route('modification'), SCOPE_2025, '1', 'authority', 10, 'value')
    )._unsafeUnwrap();

    expect(read.rankedBy).toBe('count');
  });
});
