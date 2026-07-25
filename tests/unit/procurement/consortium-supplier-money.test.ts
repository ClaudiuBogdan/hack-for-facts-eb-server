/**
 * The all-withheld supplier-money case, end to end through the executors.
 *
 * Live reproduction: authorityCui=36727850, grain=contract, 2025. Every accepted
 * award in scope belongs to a multi-member consortium, so the supplier-money
 * basis carries NOTHING: the breakdown has no value to rank by and the
 * concentration has no positive supplier value. The answers must say so —
 * a count ranking that admits it is one, money left null, and the withheld
 * consortium mass published as a NUMBER so a client never has to describe the
 * remainder as "supplier unidentified".
 */

import { describe, expect, it } from 'vitest';

import {
  analysisBreakdown,
  analysisConcentration,
} from '@/modules/procurement/core/analysis-usecases.js';

import { fakeAnalysisRepo, statsRead, verdict, type FakeBreakdownRead } from './analysis-fakes.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import type { GenerationQuality } from '@/modules/procurement/core/gate-v2.js';
import type { ConcentrationRow } from '@/modules/procurement/core/ports.js';

/** Contract spend allows, so the money verdicts below are about the DATA, not the gate. */
const SPENDING_QUALITY: GenerationQuality = {
  contract: verdict(),
  direct_acquisition: verdict(),
  procedure: verdict(),
};

const SCOPE: AnalysisScope = {
  grain: 'contract',
  authorityCui: '36727850',
  from: '2025-01',
  to: '2025-12',
};

const WITHHELD = '22262996083.00';

/** 26 dated rows, no accepted supplier money, the whole mass withheld. */
const ALL_WITHHELD_TOTALS = statsRead({
  rows: '26',
  withValue: '0',
  withEstimated: '0',
  valueAwardedSum: null,
  valueEstimatedSum: null,
  valueWithheldAssociationSum: WITHHELD,
  undatedCount: '1',
  undatedValueRon: null,
});

/** What the repo returns once it has re-ranked by count (no value to rank by). */
const COUNT_RANKED_BREAKDOWN: FakeBreakdownRead = {
  rankedBy: 'count',
  buckets: [
    { kind: 'top', key: '111', recordCount: '14', withValue: '0', valueAwardedSum: '0.00' },
    { kind: 'top', key: '222', recordCount: '8', withValue: '0', valueAwardedSum: '0.00' },
    { kind: 'other', key: null, recordCount: '4', withValue: '0', valueAwardedSum: '0.00' },
    { kind: 'unknown', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0.00' },
  ],
  totals: ALL_WITHHELD_TOTALS,
};

describe('supplier breakdown with no supplier-attributable money', () => {
  it('reports rankedBy=count and ranks the buckets by record count', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: SPENDING_QUALITY,
      breakdown: COUNT_RANKED_BREAKDOWN,
    });

    const blocks = (
      await analysisBreakdown(
        { analysisRepo: repo },
        { scope: SCOPE, dimension: 'supplier', rankBy: 'value' }
      )
    )._unsafeUnwrap();

    const block = blocks[0];
    expect(block?.rankedBy).toBe('count');
    // Count shares, because counts are what the order actually used.
    expect(block?.buckets[0]?.shareOfScope).toBe('0.5385'); // 14 / 26
    expect(block?.buckets[1]?.shareOfScope).toBe('0.3077'); // 8 / 26
  });

  it('says WHY it fell back, without claiming the money gate suppressed it', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: SPENDING_QUALITY,
      breakdown: COUNT_RANKED_BREAKDOWN,
    });

    const blocks = (
      await analysisBreakdown(
        { analysisRepo: repo },
        { scope: SCOPE, dimension: 'supplier', rankBy: 'value' }
      )
    )._unsafeUnwrap();

    const caveats = blocks[0]?.meta.caveats ?? [];
    expect(
      caveats.some((c) => c.includes('no record in this scope carries an accepted value'))
    ).toBe(true);
    expect(caveats.some((c) => c.includes('money ranking is gate-suppressed'))).toBe(false);
  });

  it('keeps every bucket money null and publishes the withheld consortium mass', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: SPENDING_QUALITY,
      breakdown: COUNT_RANKED_BREAKDOWN,
    });

    const blocks = (
      await analysisBreakdown(
        { analysisRepo: repo },
        { scope: SCOPE, dimension: 'supplier', rankBy: 'value' }
      )
    )._unsafeUnwrap();

    const block = blocks[0];
    for (const bucket of block?.buckets ?? []) {
      expect(bucket.valueAwardedSum).toBeNull();
      expect(bucket.valueSum).toBeNull();
    }
    expect(block?.valueWithheldAssociationSum).toBe(WITHHELD);
    expect(
      block?.meta.caveats.some((c) => c.includes('belongs to multi-member consortium awards'))
    ).toBe(true);
  });

  it('still reports rankedBy=value when the repo could rank on money', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: SPENDING_QUALITY,
      breakdown: {
        // No pinned rankedBy — the fake echoes the requested basis, as a repo
        // with value-bearing rows in scope would.
        buckets: [
          {
            kind: 'top',
            key: '111',
            recordCount: '20',
            withValue: '20',
            valueAwardedSum: '900.00',
          },
          { kind: 'other', key: null, recordCount: '6', withValue: '6', valueAwardedSum: '100.00' },
          { kind: 'unknown', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0.00' },
        ],
        totals: statsRead({
          rows: '26',
          withValue: '26',
          valueAwardedSum: '1000.00',
          valueWithheldAssociationSum: '0.00',
          undatedCount: '0',
        }),
      },
    });

    const blocks = (
      await analysisBreakdown(
        { analysisRepo: repo },
        { scope: SCOPE, dimension: 'supplier', rankBy: 'value' }
      )
    )._unsafeUnwrap();

    expect(blocks[0]?.rankedBy).toBe('value');
    expect(blocks[0]?.buckets[0]?.shareOfScope).toBe('0.9000'); // 900 / 1000
  });
});

describe('concentration with no supplier-attributable money', () => {
  /** Ten dated known suppliers, none of them holding attributable money. */
  const zeroRows: readonly ConcentrationRow[] = Array.from({ length: 10 }, (_, i) => ({
    supplierKey: `4${String(i).padStart(6, '0')}`,
    measure: '0.00',
  }));

  it('counts the dated known suppliers but leaves every share null', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: SPENDING_QUALITY,
      concentration: {
        rows: zeroRows,
        totals: ALL_WITHHELD_TOTALS,
        unknownSupplierMeasure: null,
      },
    });

    const blocks = (
      await analysisConcentration({ analysisRepo: repo }, { scope: SCOPE, basis: 'value' })
    )._unsafeUnwrap();

    const block = blocks[0];
    expect(block?.supplierCount).toBe(10);
    expect(block?.top1Share).toBeNull();
    expect(block?.top5Share).toBeNull();
    expect(block?.hhi).toBeNull();
    expect(block?.totalRon).toBeNull();
  });

  it('publishes the withheld consortium mass as a structured amount', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: SPENDING_QUALITY,
      concentration: {
        rows: zeroRows,
        totals: ALL_WITHHELD_TOTALS,
        unknownSupplierMeasure: null,
      },
    });

    const blocks = (
      await analysisConcentration({ analysisRepo: repo }, { scope: SCOPE, basis: 'value' })
    )._unsafeUnwrap();

    expect(blocks[0]?.valueWithheldAssociationSum).toBe(WITHHELD);
    // The prose disclosure stays too — it carries the share and the reason.
    expect(
      blocks[0]?.meta.caveats.some((c) => c.includes('belongs to multi-member consortium awards'))
    ).toBe(true);
  });

  it('quotes no amount for a value-bounded scope (the number would be silently collapsed)', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: SPENDING_QUALITY,
      concentration: {
        rows: zeroRows,
        totals: ALL_WITHHELD_TOTALS,
        unknownSupplierMeasure: null,
      },
    });

    const blocks = (
      await analysisConcentration(
        { analysisRepo: repo },
        { scope: { ...SCOPE, valueMin: 1000 }, basis: 'value' }
      )
    )._unsafeUnwrap();

    expect(blocks[0]?.valueWithheldAssociationSum).toBeNull();
    expect(
      blocks[0]?.meta.caveats.some((c) =>
        c.includes('value-bounded supplier reads exclude multi-member consortium awards')
      )
    ).toBe(true);
  });

  it('withholds the amount when the spend gate abstains for the grain', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: { ...SPENDING_QUALITY, contract: verdict({ spend: 'abstain', value: 0.76 }) },
      concentration: {
        rows: zeroRows,
        totals: ALL_WITHHELD_TOTALS,
        unknownSupplierMeasure: null,
      },
    });

    const blocks = (
      await analysisConcentration({ analysisRepo: repo }, { scope: SCOPE, basis: 'count' })
    )._unsafeUnwrap();

    expect(blocks[0]?.valueWithheldAssociationSum).toBeNull();
  });
});
