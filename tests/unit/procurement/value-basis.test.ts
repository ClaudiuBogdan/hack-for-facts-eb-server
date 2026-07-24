/**
 * Value-basis wave (design v1.1): new populations are explicit-only, every
 * money field follows ITS OWN basis verdict, and bases never substitute for
 * one another. Coverage numbers mirror the live build-6 meta rows.
 */
import { describe, expect, it } from 'vitest';

import { analysisBreakdown, analysisStats } from '@/modules/procurement/core/analysis-usecases.js';
import { routeAnalysis } from '@/modules/procurement/core/combinations.js';

import { fakeAnalysisRepo, statsRead, verdict } from './analysis-fakes.js';

const deps = (options: Parameters<typeof fakeAnalysisRepo>[0] = {}) => ({
  analysisRepo: fakeAnalysisRepo({
    quality: {
      procedure: verdict(),
      contract: verdict({ spend: 'allow_disclosed' }),
      direct_acquisition: verdict(),
    },
    ...options,
  }).repo,
});

describe('explicit-only populations', () => {
  it('implicit stats fan out over the three CORE grains only', async () => {
    const r = await analysisStats(deps(), { scope: {} });
    expect(r._unsafeUnwrap().blocks.map((b) => b.grain)).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
  });

  it('framework/calloff/modification answer when explicitly named', async () => {
    for (const grain of ['framework', 'calloff', 'modification'] as const) {
      const r = await analysisStats(deps(), { scope: { grain } });
      expect(r._unsafeUnwrap().blocks.map((b) => b.grain)).toEqual([grain]);
    }
  });
});

describe('structural rejections on the new populations', () => {
  it('framework has no supplier dimension (scope + breakdown)', () => {
    expect(routeAnalysis({ grain: 'framework', supplierCui: '123' }, 'stats').isErr()).toBe(true);
    expect(routeAnalysis({ grain: 'framework' }, 'breakdown', 'supplier').isErr()).toBe(true);
  });

  it('q is rejected on all three new populations (no title column)', () => {
    for (const grain of ['framework', 'calloff', 'modification'] as const) {
      expect(routeAnalysis({ grain, q: 'drum' }, 'stats').isErr()).toBe(true);
    }
  });

  it('modification is counts-only: value bounds rejected, concentration rejected', () => {
    expect(routeAnalysis({ grain: 'modification', valueMin: 100 }, 'stats').isErr()).toBe(true);
    expect(routeAnalysis({ grain: 'modification' }, 'concentration').isErr()).toBe(true);
    expect(routeAnalysis({ grain: 'framework' }, 'concentration').isErr()).toBe(true);
  });
});

describe('per-basis money gates (live build-6 coverage shape)', () => {
  it('framework serves the ceiling DISCLOSED (0.927) and never as awarded', async () => {
    const r = await analysisStats(
      deps({
        stats: () => statsRead({ valueAwardedSum: null, valueCeilingSum: '412330000000.00' }),
      }),
      { scope: { grain: 'framework' } }
    );
    const block = r._unsafeUnwrap().blocks[0]!;
    expect(block.valueCeilingSum).toBe('412330000000.00');
    expect(block.valueAwardedSum).toBeNull();
    expect(block.meta.answerability).toBe('degraded');
    expect(block.meta.reason).toBe('SPEND_SERVED_DISCLOSED');
    expect(block.meta.valueBasis).toBe('ceiling');
  });

  it('contract serves mod-adjusted (0.9865 ≥ allow floor) beside disclosed awarded', async () => {
    const r = await analysisStats(
      deps({ stats: () => statsRead({ valueModAdjustedSum: '1608560000000.00' }) }),
      { scope: { grain: 'contract' } }
    );
    const block = r._unsafeUnwrap().blocks[0]!;
    expect(block.valueModAdjustedSum).toBe('1608560000000.00');
    expect(block.valueAwardedSum).not.toBeNull();
  });

  it('estimated follows ITS OWN verdict: contracts abstain (0.1953), procedures disclose (0.9273)', async () => {
    const r = await analysisStats(deps(), { scope: {} });
    const blocks = r._unsafeUnwrap().blocks;
    const contract = blocks.find((b) => b.grain === 'contract')!;
    const procedure = blocks.find((b) => b.grain === 'procedure')!;
    expect(contract.valueEstimatedSum).toBeNull();
    // The contract estimated meta row is DIAGNOSTIC (population-renamed) —
    // the serving lookup misses it and abstains as unvetted (review F4).
    expect(contract.meta.caveats.join(' ')).toContain('no coverage verdict for estimated value');
    expect(procedure.valueEstimatedSum).not.toBeNull();
  });

  it('a missing coverage surface abstains every non-awarded basis (fail-closed)', async () => {
    const r = await analysisStats(deps({ basisCoverage: [] }), {
      scope: { grain: 'framework' },
    });
    const block = r._unsafeUnwrap().blocks[0]!;
    expect(block.valueCeilingSum).toBeNull();
    expect(block.meta.reason).toBe('MISSING_QUALITY_VERDICT');
  });
});

describe('breakdown anchor money', () => {
  it('framework breakdowns are withheld until Phase-2 repeat-cluster keys (review F3)', () => {
    expect(routeAnalysis({ grain: 'framework' }, 'breakdown', 'authority').isErr()).toBe(true);
    expect(routeAnalysis({ grain: 'framework' }, 'breakdown', 'cpvDivision').isErr()).toBe(true);
  });

  it('calloff buckets expose the call-off value as valueSum AND valueAwardedSum', async () => {
    const r = await analysisBreakdown(
      deps({
        stats: () => statsRead({ valueAwardedSum: '300.00', undatedCount: '0' }),
        breakdown: {
          buckets: [
            { kind: 'top', key: 'X', recordCount: '2', withValue: '2', valueAwardedSum: '200.00' },
            {
              kind: 'other',
              key: null,
              recordCount: '1',
              withValue: '1',
              valueAwardedSum: '100.00',
            },
            {
              kind: 'unknown',
              key: null,
              recordCount: '0',
              withValue: '0',
              valueAwardedSum: '0.00',
            },
          ],
          totals: statsRead({
            rows: '3',
            withValue: '3',
            valueAwardedSum: '300.00',
            undatedCount: '0',
          }),
        },
      }),
      { scope: { grain: 'calloff' }, dimension: 'authority' }
    );
    const block = r._unsafeUnwrap()[0]!;
    expect(block.rankedBy).toBe('value');
    const top = block.buckets.find((b) => b.kind === 'top')!;
    expect(top.valueSum).toBe('200.00');
    expect(top.valueAwardedSum).toBe('200.00');
    // Null-law (review F7): the zero-withValue unknown bucket emits null money.
    const unknown = block.buckets.find((b) => b.kind === 'unknown')!;
    expect(unknown.valueSum).toBeNull();
  });
});
