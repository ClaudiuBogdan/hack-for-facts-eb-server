/**
 * Breakdowns reconcile BY CONSTRUCTION (design §3.3): top + other + unknown must
 * sum exactly to the same read's totals — a mismatch is an internal error, never
 * an answer. Shares are Decimal strings of the ranking basis.
 */

import { describe, expect, it } from 'vitest';

import { analysisBreakdown } from '@/modules/procurement/core/analysis-usecases.js';

import { fakeAnalysisRepo, statsRead } from './analysis-fakes.js';

import type { AnalysisBreakdownRead } from '@/modules/procurement/core/ports.js';

const read = (over: Partial<AnalysisBreakdownRead> = {}): AnalysisBreakdownRead => ({
  buckets: [
    { kind: 'top', key: '4267117', recordCount: '50', withValue: '40', valueAwardedSum: '500.00' },
    { kind: 'top', key: '4305857', recordCount: '30', withValue: '25', valueAwardedSum: '300.00' },
    { kind: 'other', key: null, recordCount: '15', withValue: '10', valueAwardedSum: '150.00' },
    { kind: 'unknown', key: null, recordCount: '5', withValue: '5', valueAwardedSum: '50.00' },
  ],
  totals: statsRead({ rows: '100', withValue: '80', valueAwardedSum: '1000.00' }),
  ...over,
});

describe('analysisBreakdown', () => {
  it('serves top + other + unknown with Decimal shares of the value basis', async () => {
    const { repo, calls } = fakeAnalysisRepo({ breakdown: read() });
    const blocks = (
      await analysisBreakdown(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition' }, dimension: 'authority', topN: 2 }
      )
    )._unsafeUnwrap();
    const block = blocks[0];
    expect(block?.rankedBy).toBe('value');
    expect(block?.buckets.map((b) => b.kind)).toEqual(['top', 'top', 'other', 'unknown']);
    expect(block?.buckets[0]?.shareOfScope).toBe('0.5000');
    expect(block?.buckets[2]?.shareOfScope).toBe('0.1500');
    expect(block?.buckets[3]?.key).toBeNull(); // unknown = NULL dimension
    expect(calls.find((c) => c.method === 'breakdownFor')?.params).toEqual([
      'authority',
      2,
      'value',
    ]);
  });

  it('fails as an INTERNAL error when the buckets do not sum to the totals', async () => {
    const { repo } = fakeAnalysisRepo({
      breakdown: read({
        totals: statsRead({ rows: '999', withValue: '80', valueAwardedSum: '1000.00' }),
      }),
    });
    const result = await analysisBreakdown(
      { analysisRepo: repo },
      { scope: { grain: 'direct_acquisition' }, dimension: 'authority' }
    );
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('Database');
    expect(error.message).toContain('reconciliation failed');
  });

  it('spend abstain → count-ranked, money nulled in every bucket, count shares', async () => {
    const { repo, calls } = fakeAnalysisRepo({ breakdown: read() }); // contract spend abstains
    const blocks = (
      await analysisBreakdown(
        { analysisRepo: repo },
        { scope: { grain: 'contract' }, dimension: 'authority' }
      )
    )._unsafeUnwrap();
    const block = blocks[0];
    expect(block?.rankedBy).toBe('count');
    expect(calls.find((c) => c.method === 'breakdownFor')?.params?.[2]).toBe('count');
    for (const bucket of block?.buckets ?? []) {
      expect(bucket.valueAwardedSum).toBeNull();
    }
    expect(block?.buckets[0]?.shareOfScope).toBe('0.5000'); // 50 / 100 records
    expect(block?.meta.answerability).toBe('degraded');
    expect(block?.meta.reason).toBe('SPEND_COVERAGE_BELOW_GATE');
    expect(block?.meta.caveats.some((c) => c.includes('ranked by record count'))).toBe(true);
  });

  it('money reconciliation is skipped when spend abstains (totals money is unapproved)', async () => {
    // Counts still must reconcile; a value mismatch alone is invisible under abstention.
    const { repo } = fakeAnalysisRepo({
      breakdown: read({
        totals: statsRead({ rows: '100', withValue: '80', valueAwardedSum: '77777.77' }),
      }),
    });
    const result = await analysisBreakdown(
      { analysisRepo: repo },
      { scope: { grain: 'contract' }, dimension: 'authority' }
    );
    expect(result.isOk()).toBe(true);
  });

  it('a geo-gated dimension abstains with empty buckets and the geo caveat', async () => {
    const { repo, calls } = fakeAnalysisRepo({
      quality: {
        direct_acquisition: {
          coverage: { date: 0.9, value: 0.97, geo: 0.3, cpv: 0.9 },
          classes: { spend: 'allow', time: 'allow', geo: 'abstain' },
        },
      },
    });
    const blocks = (
      await analysisBreakdown(
        { analysisRepo: repo },
        { scope: { grain: 'direct_acquisition' }, dimension: 'buyerRegion' }
      )
    )._unsafeUnwrap();
    expect(blocks[0]?.buckets).toEqual([]);
    expect(blocks[0]?.meta.caveats.some((c) => c.includes('geo answers abstain'))).toBe(true);
    expect(calls.some((c) => c.method === 'breakdownFor')).toBe(false);
  });
});
