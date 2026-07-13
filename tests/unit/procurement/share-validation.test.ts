/**
 * `procurementShare` is a VALIDATED derivation over two stats reads (design
 * §3.3): identical explicit grain, identical period, numerator ⊆ denominator,
 * and both operands' money gate-allowed. A validation failure IS the answer —
 * never a partial ratio, never count/value mixing.
 */

import { describe, expect, it } from 'vitest';

import { isSubsetScope, sameWindow } from '@/modules/procurement/core/analysis-scope.js';
import { analysisShare } from '@/modules/procurement/core/analysis-usecases.js';

import { fakeAnalysisRepo, statsRead, verdict } from './analysis-fakes.js';

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
    expect(result.caveats[0]).toContain('zero awarded value');
  });
});
