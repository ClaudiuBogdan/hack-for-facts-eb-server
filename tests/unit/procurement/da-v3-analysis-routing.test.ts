/**
 * Direct acquisitions release 1 in the analysis API: with the flag on, the
 * direct_acquisition grain is answered by the procurement_v3 source behind the
 * routing repo — its own generation (buildId, verdict, notes) gates, labels
 * and reads that grain; every other grain stays on the base (ClickHouse) repo;
 * the DA grain never falls back to the base facts; routing refuses what the
 * source cannot answer honestly (title search, supplier geography, status).
 */
import { ok, err, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  analysisBreakdown,
  analysisRecords,
  analysisSeries,
  analysisStats,
} from '@/modules/procurement/core/analysis-usecases.js';
import { routeAnalysis } from '@/modules/procurement/core/combinations.js';
import { makeDaRoutingAnalysisRepo } from '@/modules/procurement/shell/repo/da-routing-analysis-repo.js';
import {
  DA_V3_CAPABILITIES,
  DA_V3_VALUE_NOTE,
  type DaV3AnalysisSource,
} from '@/modules/procurement/shell/repo/da-v3-analysis-source.js';
import { busyRetryLater, serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { BUILD_ID, fakeAnalysisRepo, generation, statsRead, verdict } from './analysis-fakes.js';

import type { GenerationQuality } from '@/modules/procurement/core/gate-v2.js';
import type { ActiveGeneration, AnalysisRecordRow } from '@/modules/procurement/core/ports.js';

const DA_BUILD = '1763435400123456';

const daGeneration = (
  quality: GenerationQuality = { direct_acquisition: verdict() }
): ActiveGeneration => ({
  buildId: DA_BUILD,
  publishedAt: '2026-11-18T03:10:00.123456Z',
  matrixHash: null,
  quality,
  capabilities: DA_V3_CAPABILITIES,
  notes: [DA_V3_VALUE_NOTE],
});

const WITHHELD_ROW: AnalysisRecordRow = {
  id: 'a'.repeat(64),
  date: '2025-07-07',
  title: null,
  authorityCui: '4305857',
  authorityName: 'COMUNA EXEMPLU',
  supplierCui: null,
  supplierName: null,
  supplierDisplayKind: 'natural_person',
  valueRon: '900.00',
  status: 'accepted',
  recordKind: null,
  cpvCode: '44110000',
  cpvLabel: 'Materiale de constructii',
};

interface FakeSource {
  readonly source: DaV3AnalysisSource;
  readonly calls: string[];
}

const fakeSource = (
  gen: Result<ActiveGeneration | null, ApiError> = ok(daGeneration())
): FakeSource => {
  const calls: string[] = [];
  const okp = <T>(value: T) => Promise.resolve(ok(value));
  return {
    calls,
    source: {
      generation: () => Promise.resolve(gen),
      statsFor: (_route, _scope, g) => {
        calls.push(`statsFor:${g.buildId}`);
        return okp(
          statsRead({ valueAwardedSum: '777.00', withEstimated: '0', valueEstimatedSum: null })
        );
      },
      seriesFor: (_route, _scope, g) => {
        calls.push(`seriesFor:${g.buildId}`);
        return okp([]);
      },
      distinctSeriesFor: (_route, _scope, g) => {
        calls.push(`distinctSeriesFor:${g.buildId}`);
        return okp([]);
      },
      breakdownFor: (_route, _scope, g, _dimension, _topN, rankBy) => {
        calls.push(`breakdownFor:${g.buildId}`);
        return okp({
          buckets: [
            {
              kind: 'top',
              key: 'natural_person',
              recordCount: '3',
              withValue: '3',
              valueAwardedSum: '1650.01',
            },
            { kind: 'other', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0.00' },
            {
              kind: 'unknown',
              key: null,
              recordCount: '1',
              withValue: '1',
              valueAwardedSum: '100.00',
            },
          ],
          totals: statsRead({ rows: '4', withValue: '4', valueAwardedSum: '1750.01' }),
          rankedBy: rankBy,
        });
      },
      concentrationFor: (_route, _scope, g) => {
        calls.push(`concentrationFor:${g.buildId}`);
        return Promise.resolve(err(serviceUnavailable('not in this test')));
      },
      recordsFor: (_route, _scope, g) => {
        calls.push(`recordsFor:${g.buildId}`);
        return okp({ total: '1', rows: [WITHHELD_ROW] });
      },
    },
  };
};

const setup = (
  options: {
    daGen?: Result<ActiveGeneration | null, ApiError>;
    base?: ActiveGeneration | null;
  } = {}
) => {
  const base = fakeAnalysisRepo(options.base === undefined ? {} : { generation: options.base });
  const da = fakeSource(options.daGen);
  const repo = makeDaRoutingAnalysisRepo(base.repo, da.source);
  return { base, da, deps: { analysisRepo: repo } };
};

describe('the routing repo', () => {
  const busy = busyRetryLater('procurement analytics is busy; retry shortly', 2);
  const busyBase = (daGen?: Result<ActiveGeneration | null, ApiError>) => {
    const base = fakeAnalysisRepo();
    return {
      analysisRepo: makeDaRoutingAnalysisRepo(
        { ...base.repo, activeGeneration: () => Promise.resolve(err(busy)) },
        fakeSource(daGen).source
      ),
    };
  };

  it('answers a busy base backend as retryable for every grain it serves', async () => {
    const deps = busyBase();
    expect((await analysisStats(deps, { scope: {} }))._unsafeUnwrapErr()).toEqual(busy);
    expect(
      (await analysisStats(deps, { scope: { grain: 'contract' } }))._unsafeUnwrapErr()
    ).toEqual(busy);
    // A pinned base grain: the pin cannot be judged while busy, so still retryable.
    expect(
      (
        await analysisStats(deps, { scope: { grain: 'contract' }, build: BUILD_ID })
      )._unsafeUnwrapErr()
    ).toEqual(busy);
    // With no DA publication either, nothing can answer: still retryable.
    expect((await analysisStats(busyBase(ok(null)), { scope: {} }))._unsafeUnwrapErr()).toEqual(
      busy
    );
  });

  it('still answers the DA grain from procurement_v3 while the base backend is busy', async () => {
    const result = await analysisStats(busyBase(), {
      scope: { grain: 'direct_acquisition' },
      build: DA_BUILD,
    });
    expect(result._unsafeUnwrap().blocks.map((block) => block.meta.buildId)).toEqual([DA_BUILD]);
  });

  it('answers busy basis coverage as retryable, not with ungated coverage', async () => {
    const base = fakeAnalysisRepo();
    const deps = {
      analysisRepo: { ...base.repo, basisCoverage: () => Promise.resolve(err(busy)) },
    };
    expect((await analysisStats(deps, { scope: {} }))._unsafeUnwrapErr()).toEqual(busy);
  });

  it('busy base coverage does not block the DA grain, which has its own', async () => {
    const base = fakeAnalysisRepo();
    const deps = {
      analysisRepo: makeDaRoutingAnalysisRepo(
        { ...base.repo, basisCoverage: () => Promise.resolve(err(busy)) },
        fakeSource().source
      ),
    };
    expect((await analysisStats(deps, { scope: {} }))._unsafeUnwrapErr()).toEqual(busy);
    const da = await analysisStats(deps, { scope: { grain: 'direct_acquisition' } });
    expect(da._unsafeUnwrap().blocks.map((block) => block.meta.buildId)).toEqual([DA_BUILD]);
  });

  it('abstains the ClickHouse grains, and still serves DA, when the base build cannot be read', async () => {
    const { deps } = setup({ base: null });
    const blocks = (await analysisStats(deps, { scope: {} }))._unsafeUnwrap().blocks;
    expect(blocks.find((b) => b.grain === 'direct_acquisition')?.meta.answerability).not.toBe(
      'abstained'
    );
    for (const block of blocks.filter((b) => b.grain !== 'direct_acquisition'))
      expect(block.meta.answerability).toBe('abstained');
  });

  it('answers an explicit DA scope from the v3 source with its own generation and note', async () => {
    const { base, da, deps } = setup();
    const result = (
      await analysisStats(deps, { scope: { grain: 'direct_acquisition' } })
    )._unsafeUnwrap();
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0];
    expect(block?.grain).toBe('direct_acquisition');
    expect(block?.meta.buildId).toBe(DA_BUILD);
    expect(block?.valueAwardedSum).toBe('777.00');
    expect(block?.meta.caveats).toContain(DA_V3_VALUE_NOTE);
    expect(block?.meta.valueBasis).toBe('counted');
    expect(block?.meta.dateBasis).toMatch(/^finalization_day/u);
    // No estimate is served from v3: its basis has no coverage row, so it abstains.
    expect(block?.valueEstimatedSum).toBeNull();
    expect(da.calls).toEqual([`statsFor:${DA_BUILD}`]);
    expect(base.calls.filter((call) => call.grain === 'direct_acquisition')).toEqual([]);
  });

  it('keeps every other grain on the base repo, each block with its own build', async () => {
    const { base, da, deps } = setup();
    const result = (await analysisStats(deps, { scope: {} }))._unsafeUnwrap();
    const byGrain = new Map(result.blocks.map((block) => [block.grain, block.meta.buildId]));
    expect(byGrain.get('direct_acquisition')).toBe(DA_BUILD);
    expect(byGrain.get('contract')).toBe(BUILD_ID);
    expect(da.calls).toEqual([`statsFor:${DA_BUILD}`]);
    expect(base.calls.map((call) => call.grain).sort()).toEqual(['contract', 'procedure']);
  });

  it('abstains on DA money without a measured verdict, and never falls back to the base facts', async () => {
    const noVerdict = setup({ daGen: ok(daGeneration({})) });
    const block = (
      await analysisStats(noVerdict.deps, { scope: { grain: 'direct_acquisition' } })
    )._unsafeUnwrap().blocks[0];
    expect(block?.valueAwardedSum).toBeNull();
    expect(block?.recordCount).toBe('100');

    const unavailable = setup({ daGen: err(serviceUnavailable('tables missing')) });
    const fallback = (
      await analysisStats(unavailable.deps, { scope: { grain: 'direct_acquisition' } })
    )._unsafeUnwrap().blocks[0];
    expect(fallback?.valueAwardedSum).toBeNull();
    expect(unavailable.base.calls.filter((call) => call.grain === 'direct_acquisition')).toEqual(
      []
    );
    // An unreadable DA publication abstains before any read (review M4).
    expect(unavailable.da.calls).toEqual([]);
    expect(fallback?.meta.answerability).toBe('abstained');
  });

  it('a DA outage never takes down the healthy grains of an unscoped request', async () => {
    const unavailable = setup({ daGen: err(serviceUnavailable('tables missing')) });
    const result = await analysisStats(unavailable.deps, { scope: {} });
    const blocks = result._unsafeUnwrap().blocks;
    expect(blocks.find((b) => b.grain === 'direct_acquisition')?.meta.answerability).toBe(
      'abstained'
    );
    expect(blocks.some((b) => b.grain !== 'direct_acquisition' && b.recordCount !== null)).toBe(
      true
    );
    expect(unavailable.da.calls).toEqual([]);
  });

  it('refuses an unscoped build pin while the DA grain publishes separately', async () => {
    const both = setup({});
    const pinned = await analysisStats(both.deps, { scope: {}, build: BUILD_ID });
    expect(pinned._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'build' });
  });

  it('answers the DA grain alone when no base generation is published', async () => {
    const { deps } = setup({ base: null });
    const block = (
      await analysisStats(deps, { scope: { grain: 'direct_acquisition' } })
    )._unsafeUnwrap().blocks[0];
    expect(block?.meta.buildId).toBe(DA_BUILD);
    expect(block?.valueAwardedSum).toBe('777.00');
  });

  it('checks a build pin against the grain the request names', async () => {
    const { deps } = setup();
    expect(
      (
        await analysisStats(deps, { scope: { grain: 'direct_acquisition' }, build: DA_BUILD })
      ).isOk()
    ).toBe(true);
    expect(
      (
        await analysisStats(deps, { scope: { grain: 'direct_acquisition' }, build: BUILD_ID })
      )._unsafeUnwrapErr().type
    ).toBe('InvalidInput');
    expect(
      (await analysisStats(deps, { scope: { grain: 'contract' }, build: BUILD_ID })).isOk()
    ).toBe(true);
  });

  it('serves the withheld supplier bucket and records exactly as the source reads them', async () => {
    const { deps } = setup();
    const breakdown = (
      await analysisBreakdown(deps, {
        scope: { grain: 'direct_acquisition' },
        dimension: 'supplier',
      })
    )._unsafeUnwrap();
    expect(breakdown[0]?.buckets.map((bucket) => bucket.key)).toContain('natural_person');
    const records = (
      await analysisRecords(deps, { scope: { grain: 'direct_acquisition' }, sort: 'value_desc' })
    )._unsafeUnwrap();
    expect(records.meta.buildId).toBe(DA_BUILD);
    expect(records.items).toEqual([WITHHELD_ROW]);
    const series = await analysisSeries(deps, {
      scope: { grain: 'direct_acquisition' },
      measure: 'distinctSuppliers',
      bucket: 'year',
    });
    expect(series.isOk()).toBe(true);
  });
});

describe('routing on a DA-v3 generation', () => {
  const caps = { ...generation().capabilities, directAcquisitionV3: true };
  const reject = (
    scope: Parameters<typeof routeAnalysis>[0],
    dimension?: Parameters<typeof routeAnalysis>[2]
  ) =>
    routeAnalysis(
      scope,
      dimension === undefined ? 'stats' : 'breakdown',
      dimension,
      undefined,
      caps
    );

  it.each([
    [{ grain: 'direct_acquisition', q: 'beton' }, undefined, 'free text is withheld'],
    [{ grain: 'direct_acquisition', supplierCounty: 'CJ' }, undefined, 'no supplier geography'],
    [{ grain: 'direct_acquisition' }, 'supplierRegion', 'no supplier geography'],
    [{ grain: 'direct_acquisition', status: 'accepted' }, undefined, 'no status dimension'],
    [{ grain: 'direct_acquisition' }, 'status', 'no status dimension'],
  ] as const)('refuses %j %s at the DA grain', (scope, dimension, message) => {
    const result = reject(scope, dimension);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(message);
  });

  it('skips the DA grain, not the request, when the grain set is implicit', () => {
    const routes = reject({ q: 'beton' })
      ._unsafeUnwrap()
      .map((route) => route.grain);
    expect(routes).not.toContain('direct_acquisition');
    expect(routes).toContain('contract');
  });

  it('changes nothing without the capability', () => {
    const plain = routeAnalysis(
      { grain: 'direct_acquisition', q: 'beton' },
      'stats',
      undefined,
      undefined,
      generation().capabilities
    );
    expect(plain.isOk()).toBe(true);
  });
});
