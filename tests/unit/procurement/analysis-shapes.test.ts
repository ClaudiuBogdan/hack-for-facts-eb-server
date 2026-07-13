/**
 * The shape executors over an in-memory AnalysisRepo: labeled per-grain stats
 * blocks (money nulled on abstain, never zeroed into a sum), series bucket
 * derivation (additive only — distincts are repo-bucketed), undated-population
 * rules in both scope modes, and concentration basis forcing.
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  analysisBreakdown,
  analysisConcentration,
  analysisFacets,
  analysisSeries,
  analysisShare,
  analysisStats,
} from '@/modules/procurement/core/analysis-usecases.js';

import { BUILD_ID, fakeAnalysisRepo, generation, statsRead, verdict } from './analysis-fakes.js';

import type { AnalysisRepo } from '@/modules/procurement/core/ports.js';

describe('analysisStats — labeled per-grain blocks', () => {
  it('returns one block per routed grain and NO cross-grain sum field', async () => {
    const { repo } = fakeAnalysisRepo();
    const result = (await analysisStats({ analysisRepo: repo }, { scope: {} }))._unsafeUnwrap();
    expect(result.blocks.map((b) => b.grain)).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
    expect(Object.keys(result)).toEqual(['blocks']); // nothing sums the grains
  });

  it('nulls money (not zero) with a caveat where spend abstains; serves it where allowed', async () => {
    const { repo } = fakeAnalysisRepo(); // live-like: contract spend abstains
    const result = (await analysisStats({ analysisRepo: repo }, { scope: {} }))._unsafeUnwrap();
    const byGrain = new Map(result.blocks.map((b) => [b.grain, b]));

    const contract = byGrain.get('contract');
    expect(contract?.valueAwardedSum).toBeNull();
    expect(contract?.valueEstimatedSum).toBeNull();
    expect(contract?.avgValueAwarded).toBeNull();
    expect(contract?.recordCount).toBe('100'); // counts are always allowed
    expect(contract?.meta.caveats.some((c) => c.includes('spend answers abstain'))).toBe(true);
    expect(contract?.meta.undatedInScope?.valueRon).toBeNull(); // undated money follows spend

    const da = byGrain.get('direct_acquisition');
    expect(da?.valueAwardedSum).toBe('1000.00');
    expect(da?.meta.undatedInScope).toEqual({ count: '5', valueRon: '50.00' });
  });

  it('computes avg = awarded sum / WITH-VALUE count as a decimal string', async () => {
    const { repo } = fakeAnalysisRepo({
      stats: () => statsRead({ valueAwardedSum: '1000.00', withValue: '80' }),
    });
    const result = (
      await analysisStats({ analysisRepo: repo }, { scope: { grain: 'direct_acquisition' } })
    )._unsafeUnwrap();
    expect(result.blocks[0]?.avgValueAwarded).toBe('12.50');
  });

  it('contract money is provisional (no terminality signal); DA money is not', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: { contract: verdict(), direct_acquisition: verdict(), procedure: verdict() },
    });
    const result = (await analysisStats({ analysisRepo: repo }, { scope: {} }))._unsafeUnwrap();
    const byGrain = new Map(result.blocks.map((b) => [b.grain, b]));
    expect(byGrain.get('contract')?.meta.provisional).toBe(true);
    expect(byGrain.get('direct_acquisition')?.meta.provisional).toBe(false);
  });

  it('fails with the clean not-published error when no generation is active', async () => {
    const { repo } = fakeAnalysisRepo({ generation: null });
    const result = await analysisStats({ analysisRepo: repo }, { scope: {} });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
      message: 'procurement analysis package not published',
    });
  });

  it('fails analysis closed when the active generation uses another matrix', async () => {
    const { repo, calls } = fakeAnalysisRepo({
      generation: { ...generation(), matrixHash: 'older-matrix' },
    });
    const result = await analysisStats({ analysisRepo: repo }, { scope: {} });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
      message: expect.stringContaining('older-matrix'),
    });
    expect(calls).toHaveLength(0);
  });

  it('stamps the pinned buildId and the canonical scope echo on every envelope', async () => {
    const { repo } = fakeAnalysisRepo();
    const scope = { authorityCui: '4267117', from: '2024-01', to: '2024-06' };
    const result = (await analysisStats({ analysisRepo: repo }, { scope }))._unsafeUnwrap();
    for (const block of result.blocks) {
      expect(block.meta.buildId).toBe(BUILD_ID);
      expect(block.meta.canonicalScope).toBe('authorityCui=4267117&from=2024-01&to=2024-06');
      expect(block.meta.population).toBe('canonical-only');
    }
  });
});

describe('analysisSeries — buckets, laws, undated rules', () => {
  const monthly = [
    { month: null, value: '7', recordCount: '7', withValue: '3', valueAwardedSum: '70.00' },
    { month: '2024-01', value: '10', recordCount: '10', withValue: '8', valueAwardedSum: '100.00' },
    {
      month: '2024-02',
      value: '20',
      recordCount: '20',
      withValue: '15',
      valueAwardedSum: '200.00',
    },
    { month: '2024-04', value: '5', recordCount: '5', withValue: '4', valueAwardedSum: '50.00' },
  ];

  it('derives quarter buckets in core for ADDITIVE measures only', async () => {
    const { repo } = fakeAnalysisRepo({ series: monthly });
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition' }, bucket: 'quarter', measure: 'recordCount' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.points).toEqual([
      { bucket: '2024-Q1', value: '30' },
      { bucket: '2024-Q2', value: '5' },
    ]);
  });

  it('keeps the undated bucket OUT of the points and IN the envelope', async () => {
    const { repo } = fakeAnalysisRepo({ series: monthly });
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        {
          scope: { grain: 'direct_acquisition', from: '2024-01', to: '2024-06' },
          bucket: 'month',
          measure: 'recordCount',
        }
      )
    )._unsafeUnwrap();
    const block = blocks[0];
    expect(block?.points.map((p) => p.bucket)).toEqual(['2024-01', '2024-02', '2024-04']);
    expect(block?.meta.undatedInScope).toEqual({ count: '7', valueRon: '70.00' });
  });

  it('distinct measures are repo-bucketed — core passes the bucket through, never re-derives', async () => {
    const { repo, calls } = fakeAnalysisRepo({
      distinct: [
        {
          bucket: '2024-Q1',
          value: '12',
          recordCount: '30',
          withValue: '20',
          valueAwardedSum: null,
        },
      ],
    });
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        {
          scope: { grain: 'direct_acquisition', authorityCui: '4267117' },
          bucket: 'quarter',
          measure: 'distinctSuppliers',
        }
      )
    )._unsafeUnwrap();
    const call = calls.find((c) => c.method === 'distinctSeriesFor');
    expect(call?.params).toEqual(['supplier', 'quarter']); // the REPO buckets
    expect(blocks[0]?.points).toEqual([{ bucket: '2024-Q1', value: '12' }]);
    expect(blocks[0]?.meta.caveats.some((c) => c.includes('never be summed across buckets'))).toBe(
      true
    );
  });

  it('rejects a ratio measure for series (stats-only per the policy table)', async () => {
    const { repo } = fakeAnalysisRepo();
    const result = await analysisSeries(
      { analysisRepo: repo },
      { scope: { grain: 'direct_acquisition' }, bucket: 'month', measure: 'avgValueAwarded' }
    );
    expect(result._unsafeUnwrapErr().message).toContain("not legal for shape 'series'");
  });

  it('an explicit procedure-grain time series is blocked with the milestone named', async () => {
    const { repo, calls } = fakeAnalysisRepo();
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        { scope: { grain: 'procedure' }, bucket: 'month', measure: 'recordCount' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.points).toEqual([]);
    expect(blocks[0]?.meta.answerability).toBe('abstained');
    expect(blocks[0]?.meta.reason).toBe('GENERATION_LACKS_CAPABILITY');
    expect(blocks[0]?.meta.caveats[0]).toContain('missing-date-basis');
    expect(blocks[0]?.meta.caveats[0]).toContain('M1');
    expect(calls.some((call) => call.method === 'seriesFor')).toBe(false);
  });

  it('an implicit-grain series serves the other grains and flags the blocked procedure block', async () => {
    const { repo, calls } = fakeAnalysisRepo({ series: monthly });
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        { scope: {}, bucket: 'month', measure: 'recordCount' }
      )
    )._unsafeUnwrap();
    const procedure = blocks.find((b) => b.grain === 'procedure');
    expect(procedure?.points).toEqual([]);
    expect(procedure?.meta.caveats.some((c) => c.includes('missing-date-basis'))).toBe(true);
    // The blocked grain never hits the repo.
    expect(calls.filter((c) => c.method === 'seriesFor').map((c) => c.grain)).toEqual([
      'contract',
      'direct_acquisition',
    ]);
  });

  it('a money series abstains entirely (no points) when spend abstains', async () => {
    const { repo, calls } = fakeAnalysisRepo({ series: monthly }); // contract spend abstains
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        { scope: { grain: 'contract' }, bucket: 'month', measure: 'valueAwardedSum' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.points).toEqual([]);
    expect(blocks[0]?.meta.caveats.some((c) => c.includes('spend answers abstain'))).toBe(true);
    expect(calls.some((c) => c.method === 'seriesFor')).toBe(false); // abstained before reading
  });

  it('time degradation serves the series WITH the coverage caveat', async () => {
    const { repo } = fakeAnalysisRepo({
      series: monthly,
      quality: { direct_acquisition: verdict({ time: 'degraded', date: 0.65 }) },
    });
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition' }, bucket: 'month', measure: 'recordCount' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.points.length).toBeGreaterThan(0);
    expect(blocks[0]?.meta.caveats.some((c) => c.includes('degraded'))).toBe(true);
  });
});

describe('analysisBreakdown — topN contract', () => {
  it.each([
    [undefined, 10],
    [1, 1],
    [50, 50],
  ] as const)('accepts topN=%s and passes %s to the repository', async (topN, expected) => {
    const { repo, calls } = fakeAnalysisRepo();
    const result = await analysisBreakdown(
      { analysisRepo: repo },
      {
        scope: { grain: 'contract' },
        dimension: 'supplier',
        ...(topN === undefined ? {} : { topN }),
      }
    );

    expect(result.isOk()).toBe(true);
    expect(calls.find((call) => call.method === 'breakdownFor')?.params[1]).toBe(expected);
  });

  it.each([0, 51, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects explicit topN=%s before repository reads',
    async (topN) => {
      const { repo, calls } = fakeAnalysisRepo();
      const result = await analysisBreakdown(
        { analysisRepo: repo },
        { scope: { grain: 'contract' }, dimension: 'supplier', topN }
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.message).toContain('topN');
      expect(calls).toHaveLength(0);
    }
  );
});

describe('analysisConcentration — basis forcing + Decimal outputs', () => {
  const rows = [
    { supplierKey: 'A', measure: '600.00' },
    { supplierKey: 'B', measure: '300.00' },
    { supplierKey: 'C', measure: '100.00' },
  ];
  const read = { rows, totals: statsRead(), unknownSupplierMeasure: null };

  it('computes HHI/top shares as decimal strings on the value basis', async () => {
    const { repo } = fakeAnalysisRepo({ concentration: read });
    const blocks = (
      await analysisConcentration(
        { analysisRepo: repo },
        {
          scope: { authorityCui: '4267117', grain: 'direct_acquisition' },
          basis: 'value',
        }
      )
    )._unsafeUnwrap();
    const block = blocks[0];
    expect(block?.basis).toBe('value');
    expect(block?.supplierCount).toBe(3);
    expect(block?.top1Share).toBe('0.6000');
    expect(block?.top5Share).toBe('1.0000');
    expect(block?.hhi).toBe('0.4600'); // 0.36 + 0.09 + 0.01
    expect(block?.totalRon).toBe('1000.00');
  });

  it('abstains on explicit value basis when spend is blocked (never falls back)', async () => {
    const { repo, calls } = fakeAnalysisRepo({ concentration: read });
    const blocks = (
      await analysisConcentration(
        { analysisRepo: repo },
        { scope: { authorityCui: '4267117', grain: 'contract' }, basis: 'value' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.basis).toBe('value');
    expect(blocks[0]?.totalRon).toBeNull();
    expect(blocks[0]?.meta.answerability).toBe('abstained');
    expect(blocks[0]?.meta.reason).toBe('SPEND_COVERAGE_BELOW_GATE');
    expect(calls.some((c) => c.method === 'concentrationRowsFor')).toBe(false);
  });
});

describe('gate composition + honest blocked envelopes (S3)', () => {
  it('a time-bounded stats scope with an abstaining time class blocks the block — nothing is read or fabricated', async () => {
    const { repo, calls } = fakeAnalysisRepo({
      quality: { direct_acquisition: verdict({ time: 'abstain', date: 0.3 }) },
    });
    const result = (
      await analysisStats(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition', from: '2024-01', to: '2024-06' } }
      )
    )._unsafeUnwrap();
    const block = result.blocks[0];
    expect(block?.recordCount).toBeNull(); // not read — never a fabricated zero
    expect(block?.meta.counts).toBeNull();
    expect(block?.meta.undatedInScope).toBeNull();
    expect(block?.meta.caveats.some((c) => c.includes('time answers abstain'))).toBe(true);
    expect(calls.some((c) => c.method === 'statsFor')).toBe(false);
  });

  it('a NON-temporal stats scope ignores the time class entirely', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: { direct_acquisition: verdict({ time: 'abstain', date: 0.3 }) },
    });
    const result = (
      await analysisStats({ analysisRepo: repo }, { scope: { grain: 'direct_acquisition' } })
    )._unsafeUnwrap();
    expect(result.blocks[0]?.recordCount).toBe('100');
  });

  it('a degraded time class SERVES a windowed stats block with the coverage caveat', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: { direct_acquisition: verdict({ time: 'degraded', date: 0.65 }) },
    });
    const result = (
      await analysisStats(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition', year: 2024 } }
      )
    )._unsafeUnwrap();
    expect(result.blocks[0]?.recordCount).toBe('100');
    expect(result.blocks[0]?.meta.caveats.some((c) => c.includes('degraded'))).toBe(true);
  });

  it('a buyerRegion-scoped concentration/stats consults the geo class', async () => {
    const { repo, calls } = fakeAnalysisRepo({
      quality: { direct_acquisition: verdict({ geo: 'abstain' }) },
    });
    const result = (
      await analysisStats(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition', buyerRegion: 'Nord-Vest' } }
      )
    )._unsafeUnwrap();
    expect(result.blocks[0]?.meta.counts).toBeNull();
    expect(result.blocks[0]?.meta.caveats.some((c) => c.includes('geo answers abstain'))).toBe(
      true
    );
    expect(calls.some((c) => c.method === 'statsFor')).toBe(false);
  });
});

describe('null money is preserved end-to-end (S8)', () => {
  it('stats: a scope with no valued rows keeps money null with the unobserved caveat', async () => {
    const { repo } = fakeAnalysisRepo({
      stats: () => statsRead({ valueAwardedSum: null, valueEstimatedSum: null, withValue: '0' }),
    });
    const result = (
      await analysisStats({ analysisRepo: repo }, { scope: { grain: 'direct_acquisition' } })
    )._unsafeUnwrap();
    const block = result.blocks[0];
    expect(block?.recordCount).toBe('100'); // counts still real
    expect(block?.valueAwardedSum).toBeNull();
    expect(block?.avgValueAwarded).toBeNull();
    expect(block?.meta.caveats.some((c) => c.includes('no awarded values observed'))).toBe(true);
  });

  it('series: a derived bucket whose months all report null stays null, not zero', async () => {
    const { repo } = fakeAnalysisRepo({
      series: [
        { month: '2024-01', value: null, recordCount: '3', withValue: '0', valueAwardedSum: null },
        { month: '2024-02', value: null, recordCount: '2', withValue: '0', valueAwardedSum: null },
        {
          month: '2024-04',
          value: '9.00',
          recordCount: '1',
          withValue: '1',
          valueAwardedSum: '9.00',
        },
      ],
    });
    const blocks = (
      await analysisSeries(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition' }, bucket: 'quarter', measure: 'valueAwardedSum' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.points).toEqual([
      { bucket: '2024-Q1', value: null },
      { bucket: '2024-Q2', value: '9.00' },
    ]);
  });

  it('concentration: no positive-basis supplier → totalRon null, count intact', async () => {
    const { repo } = fakeAnalysisRepo({
      concentration: {
        rows: [
          { supplierKey: 'A', measure: '0' },
          { supplierKey: 'B', measure: '0' },
        ],
        totals: statsRead({ valueAwardedSum: null }),
        unknownSupplierMeasure: null,
      },
    });
    const blocks = (
      await analysisConcentration(
        { analysisRepo: repo },
        { scope: { authorityCui: 'x', grain: 'direct_acquisition' }, basis: 'value' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.supplierCount).toBe(2); // known suppliers, basis-independent (S7)
    expect(blocks[0]?.totalRon).toBeNull();
    expect(blocks[0]?.hhi).toBeNull();
  });
});

describe('concentration semantics (S7)', () => {
  it('counts ALL known suppliers, computes HHI over positives, and discloses both + the unknown weight', async () => {
    const { repo } = fakeAnalysisRepo({
      concentration: {
        rows: [
          { supplierKey: 'A', measure: '600.00' },
          { supplierKey: 'B', measure: '400.00' },
          { supplierKey: 'C', measure: '0' },
        ],
        totals: statsRead(),
        unknownSupplierMeasure: '123.45',
      },
    });
    const blocks = (
      await analysisConcentration(
        { analysisRepo: repo },
        { scope: { authorityCui: 'x', grain: 'direct_acquisition' }, basis: 'value' }
      )
    )._unsafeUnwrap();
    const block = blocks[0];
    expect(block?.supplierCount).toBe(3);
    expect(block?.hhi).toBe('0.5200'); // over the 2 positive suppliers only
    expect(
      block?.meta.caveats.some((c) => c.includes('positive awarded value (2 of 3 known suppliers)'))
    ).toBe(true);
    expect(
      block?.meta.caveats.some((c) => c.includes('unknown supplier') && c.includes('123.45'))
    ).toBe(true);
  });
});

describe('one generation per request (S1)', () => {
  const withIncrementingGeneration = (): { repo: AnalysisRepo; genCalls: () => number } => {
    const base = fakeAnalysisRepo({
      quality: { procedure: verdict(), contract: verdict(), direct_acquisition: verdict() },
    });
    let calls = 0;
    const repo: AnalysisRepo = {
      ...base.repo,
      activeGeneration: () => {
        calls += 1;
        return Promise.resolve(
          ok({
            ...generation({
              procedure: verdict(),
              contract: verdict(),
              direct_acquisition: verdict(),
            }),
            buildId: String(calls),
          })
        );
      },
    };
    return { repo, genCalls: () => calls };
  };

  it('share resolves ONE generation and pins both operands to it (no cross-build ratio)', async () => {
    const { repo, genCalls } = withIncrementingGeneration();
    const result = (
      await analysisShare(
        { analysisRepo: repo },
        {
          numerator: { authorityCui: 'a', supplierCui: 's', grain: 'direct_acquisition' },
          denominator: { authorityCui: 'a', grain: 'direct_acquisition' },
        }
      )
    )._unsafeUnwrap();
    expect(genCalls()).toBe(1);
    expect(result.numerator.meta.buildId).toBe('1');
    expect(result.denominator.meta.buildId).toBe('1');
  });

  it('facets resolve ONE generation across every dimension', async () => {
    const { repo, genCalls } = withIncrementingGeneration();
    const result = (
      await analysisFacets(
        { analysisRepo: repo },
        {
          scope: { authorityCui: 'a', grain: 'contract' },
          dimensions: ['cpvDivision', 'status'],
        }
      )
    )._unsafeUnwrap();
    expect(genCalls()).toBe(1);
    expect(new Set(result.blocks.map((b) => b.meta.buildId))).toEqual(new Set(['1']));
    expect(result.blocks.map((b) => b.dimension)).toEqual(['cpvDivision', 'status']);
  });

  it('facets REQUIRE an explicit grain (statement-budget constraint, S5)', async () => {
    const { repo } = fakeAnalysisRepo();
    const result = await analysisFacets(
      { analysisRepo: repo },
      { scope: { authorityCui: 'a' }, dimensions: ['cpvDivision'] }
    );
    expect(result._unsafeUnwrapErr().message).toContain('explicit scope.grain');
  });
});
