/**
 * `procurementShare` is a VALIDATED derivation over two stats reads (design
 * §3.3): identical explicit grain, identical period, numerator ⊆ denominator,
 * and both operands' money gate-allowed. A validation failure IS the answer —
 * never a partial ratio, never count/value mixing.
 */

import { describe, expect, it } from 'vitest';

import { isSubsetScope, sameWindow } from '@/modules/procurement/core/analysis-scope.js';
import { analysisShare } from '@/modules/procurement/core/analysis-usecases.js';

import { fakeAnalysisRepo, generation, statsRead, verdict } from './analysis-fakes.js';

const ALL_ALLOW = {
  procedure: verdict(),
  contract: verdict(),
  direct_acquisition: verdict(),
};

describe('scope subset/period helpers', () => {
  it('isSubsetScope: every denominator constraint must be set identically on the numerator', () => {
    expect(isSubsetScope({ authorityCui: 'a', supplierCui: 's' }, { authorityCui: 'a' })).toBe(
      true
    );
    expect(isSubsetScope({ supplierCui: 's' }, { authorityCui: 'a' })).toBe(false);
    expect(isSubsetScope({ authorityCui: 'OTHER' }, { authorityCui: 'a' })).toBe(false);
    expect(isSubsetScope({}, {})).toBe(true);
  });

  it('isSubsetScope: row filters (q/value bounds) participate in the subset law', () => {
    // Denominator row filter absent (or different) on the numerator → not a subset.
    expect(isSubsetScope({ authorityCui: 'a' }, { authorityCui: 'a', q: 'drum' })).toBe(false);
    expect(isSubsetScope({ authorityCui: 'a', valueMin: 500 }, { valueMin: 1000 })).toBe(false);
    // Numerator may ADD row filters.
    expect(isSubsetScope({ authorityCui: 'a', q: 'drum' }, { authorityCui: 'a' })).toBe(true);
  });

  it('sameWindow compares the NORMALIZED window: year 2024 == from/to 2024-01..12', () => {
    expect(sameWindow({ from: '2024-01', to: '2024-12' }, { from: '2024-01', to: '2024-12' })).toBe(
      true
    );
    expect(sameWindow({ year: 2024 }, { from: '2024-01', to: '2024-12' })).toBe(true);
    expect(sameWindow({ year: 2024 }, { from: '2024-01' })).toBe(false);
    expect(sameWindow({}, { year: 2024 })).toBe(false);
  });
});

describe('analysisShare validation failures ARE the answer', () => {
  it('rejects operands without the same explicit grain', async () => {
    const { repo } = fakeAnalysisRepo({ quality: ALL_ALLOW });
    const noGrain = await analysisShare(
      { analysisRepo: repo },
      { numerator: { authorityCui: 'a', supplierCui: 's' }, denominator: { authorityCui: 'a' } }
    );
    expect(noGrain._unsafeUnwrapErr().message).toContain('same EXPLICIT grain');

    const mismatch = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { authorityCui: 'a', supplierCui: 's', grain: 'contract' },
        denominator: { authorityCui: 'a', grain: 'direct_acquisition' },
      }
    );
    expect(mismatch._unsafeUnwrapErr().message).toContain('same EXPLICIT grain');
  });

  it('rejects a period mismatch', async () => {
    const { repo } = fakeAnalysisRepo({ quality: ALL_ALLOW });
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { authorityCui: 'a', supplierCui: 's', grain: 'direct_acquisition', year: 2024 },
        denominator: { authorityCui: 'a', grain: 'direct_acquisition', year: 2023 },
      }
    );
    expect(result._unsafeUnwrapErr().message).toContain('identical period');
  });

  it('rejects an IDENTICAL scope pair (subset must be strict)', async () => {
    const { repo } = fakeAnalysisRepo({ quality: ALL_ALLOW });
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { authorityCui: 'a', grain: 'direct_acquisition' },
        denominator: { authorityCui: 'a', grain: 'direct_acquisition' },
      }
    );
    expect(result._unsafeUnwrapErr().message).toContain('STRICT subset');
  });

  it('accepts year vs its equivalent from/to window as the same period', async () => {
    const { repo } = fakeAnalysisRepo({ quality: ALL_ALLOW });
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: {
          authorityCui: 'a',
          supplierCui: 's',
          grain: 'direct_acquisition',
          year: 2024,
        },
        denominator: {
          authorityCui: 'a',
          grain: 'direct_acquisition',
          from: '2024-01',
          to: '2024-12',
        },
      }
    );
    expect(result.isOk()).toBe(true);
  });

  it('rejects a numerator that is not a subset of the denominator', async () => {
    const { repo } = fakeAnalysisRepo({ quality: ALL_ALLOW });
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { supplierCui: 's', grain: 'direct_acquisition' },
        denominator: { authorityCui: 'a', grain: 'direct_acquisition' },
      }
    );
    expect(result._unsafeUnwrapErr().message).toContain('subset');
  });

  it('a gate-blocked operand returns an abstained share — never a count-based ratio', async () => {
    const { repo } = fakeAnalysisRepo(); // live-like: contract spend abstains
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { authorityCui: 'a', supplierCui: 's', grain: 'contract' },
        denominator: { authorityCui: 'a', grain: 'contract' },
      }
    );
    const share = result._unsafeUnwrap();
    expect(share.share).toBeNull();
    expect(share.answerability).toBe('abstained');
    expect(share.reason).toBe('SPEND_COVERAGE_BELOW_GATE');
  });
});

describe('analysisShare happy path', () => {
  it('propagates a degraded time verdict and typed reason from its operands', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: {
        ...ALL_ALLOW,
        direct_acquisition: verdict({ time: 'degraded', date: 0.65 }),
      },
    });
    const result = (
      await analysisShare(
        { analysisRepo: repo },
        {
          numerator: {
            authorityCui: 'a',
            supplierCui: 's',
            grain: 'direct_acquisition',
            year: 2024,
          },
          denominator: { authorityCui: 'a', grain: 'direct_acquisition', year: 2024 },
        }
      )
    )._unsafeUnwrap();

    expect(result.answerability).toBe('degraded');
    expect(result.reason).toBe('TIME_COVERAGE_DEGRADED');
    expect(result.caveats.some((caveat) => caveat.includes('time answers are degraded'))).toBe(
      true
    );
  });

  it('derives the ratio from two stats reads as a decimal string', async () => {
    const { repo, calls } = fakeAnalysisRepo({
      quality: ALL_ALLOW,
      stats: (grain) =>
        statsRead({ valueAwardedSum: grain === 'direct_acquisition' ? '1000.00' : '0' }),
    });
    // Both operands resolve to DA; the fake serves 1000.00 for both, so the edge
    // is exercised by scoping: numerator narrows by supplier.
    const result = (
      await analysisShare(
        { analysisRepo: repo },
        {
          numerator: { authorityCui: 'a', supplierCui: 's', grain: 'direct_acquisition' },
          denominator: { authorityCui: 'a', grain: 'direct_acquisition' },
        }
      )
    )._unsafeUnwrap();
    expect(result.share).toBe('1.0000');
    expect(result.numerator.grain).toBe('direct_acquisition');
    expect(result.denominator.grain).toBe('direct_acquisition');
    expect(calls.filter((c) => c.method === 'statsFor')).toHaveLength(2);
  });

  it('a numerator narrowed ONLY by a row filter (q / value bound) is a valid strict subset', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: ALL_ALLOW,
      stats: () => statsRead({ valueAwardedSum: '1000.00' }),
    });
    const result = (
      await analysisShare(
        { analysisRepo: repo },
        {
          numerator: { authorityCui: 'a', valueMin: 1_000_000, grain: 'direct_acquisition' },
          denominator: { authorityCui: 'a', grain: 'direct_acquisition' },
        }
      )
    )._unsafeUnwrap();
    expect(result.share).toBe('1.0000');
  });

  it('a zero denominator yields share: null with a caveat, not a division blow-up', async () => {
    const { repo } = fakeAnalysisRepo({
      quality: ALL_ALLOW,
      stats: () => statsRead({ valueAwardedSum: '0' }),
    });
    const result = (
      await analysisShare(
        { analysisRepo: repo },
        {
          numerator: { authorityCui: 'a', supplierCui: 's', grain: 'direct_acquisition' },
          denominator: { authorityCui: 'a', grain: 'direct_acquisition' },
        }
      )
    )._unsafeUnwrap();
    expect(result.share).toBeNull();
    expect(result.caveats[0]).toContain('zero anchor-money value');
  });
});

describe('frameworkRole compares as a POPULATION once the build publishes the column (M/M06)', () => {
  // Absent = purchases-only default (standalone / unstamped), 'all' widens.
  const withColumn = () =>
    fakeAnalysisRepo({
      generation: generation(ALL_ALLOW, { frameworkRole: true }),
      stats: () => statsRead({ valueAwardedSum: '1000.00' }),
    });

  it("rejects a numerator widened by frameworkRole='all' over a default denominator", async () => {
    const { repo } = withColumn();
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { grain: 'contract', authorityCui: 'a', frameworkRole: 'all' },
        denominator: { grain: 'contract', authorityCui: 'a' },
      }
    );
    expect(result._unsafeUnwrapErr().message).toContain('STRICT subset');
  });

  it("accepts the purchases-only default as a strict subset of frameworkRole='all'", async () => {
    const { repo } = withColumn();
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { grain: 'contract', authorityCui: 'a' },
        denominator: { grain: 'contract', authorityCui: 'a', frameworkRole: 'all' },
      }
    );
    expect(result._unsafeUnwrap().share).toBe('1.0000');
  });

  it('accepts one named role inside all, rejects a role outside a different role', async () => {
    const { repo } = withColumn();
    const inside = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { grain: 'contract', frameworkRole: 'call_off' },
        denominator: { grain: 'contract', frameworkRole: 'all' },
      }
    );
    expect(inside.isOk()).toBe(true);
    const disjoint = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { grain: 'contract', authorityCui: 'a', frameworkRole: 'call_off' },
        denominator: { grain: 'contract', frameworkRole: 'framework_ceiling' },
      }
    );
    expect(disjoint._unsafeUnwrapErr().message).toContain('STRICT subset');
  });

  it('models the default as standalone ∪ unstamped: standalone ⊂ default, never the reverse', async () => {
    const { repo } = withColumn();
    // Explicit standalone excludes unstamped rows → a strict subset of the default.
    const narrower = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { grain: 'contract', frameworkRole: 'standalone' },
        denominator: { grain: 'contract' },
      }
    );
    expect(narrower._unsafeUnwrap().share).toBe('1.0000');
    // The default (with unstamped rows) is NOT inside explicit standalone, even
    // when the numerator adds another constraint.
    const wider = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { grain: 'contract', authorityCui: 'a' },
        denominator: { grain: 'contract', frameworkRole: 'standalone' },
      }
    );
    expect(wider._unsafeUnwrapErr().message).toContain('STRICT subset');
    // Identical default populations with nothing else narrower: a tautology.
    const identical = await analysisShare(
      { analysisRepo: repo },
      { numerator: { grain: 'contract' }, denominator: { grain: 'contract' } }
    );
    expect(identical._unsafeUnwrapErr().message).toContain('STRICT subset');
  });

  it('without the column, a frameworkRole operand is refused at routing as before', async () => {
    const { repo } = fakeAnalysisRepo({ quality: ALL_ALLOW });
    const result = await analysisShare(
      { analysisRepo: repo },
      {
        numerator: { grain: 'contract', authorityCui: 'a', frameworkRole: 'all' },
        denominator: { grain: 'contract' },
      }
    );
    expect(result._unsafeUnwrapErr().message).toContain('unavailable');
  });
});
