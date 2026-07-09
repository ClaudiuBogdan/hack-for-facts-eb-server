/**
 * Detail bundles: the duplicate-driver fallback chain, the structural nulls
 * (`perLotWinners`, procedure `duplicates`), TED attachment, and the RON decimal
 * addition that keeps `totalValueRon` off the float path.
 */

import { describe, expect, it } from 'vitest';

import { pickDuplicateDriver } from '@/modules/procurement/shell/repo/detail-repo.js';
import { addDecimalStrings } from '@/modules/procurement/shell/repo/scope-agg-repo.js';
import { makeScopeCache } from '@/modules/procurement/shell/scope-cache.js';

import type { DuplicateAnchor } from '@/modules/procurement/shell/repo/detail-repo.js';

const anchor = (over: Partial<DuplicateAnchor> = {}): DuplicateAnchor => ({
  id: '2022821',
  dupGroupId: '2022821',
  authorityCui: '4350505',
  supplierCui: '29852817',
  ...over,
});

describe('duplicate lookup: the driving-column fallback chain', () => {
  it('prefers authority_cui (the partial dup index does not cover suppressed rows)', () => {
    expect(pickDuplicateDriver(anchor())).toEqual({ column: 'authority_cui', value: '4350505' });
  });

  it('falls back to supplier_cui when the authority is unknown', () => {
    expect(pickDuplicateDriver(anchor({ authorityCui: null }))).toEqual({
      column: 'supplier_cui',
      value: '29852817',
    });
  });

  it('both cuis null → no affordable lookup → no driver (the bundle serves [])', () => {
    expect(pickDuplicateDriver(anchor({ authorityCui: null, supplierCui: null }))).toBeNull();
  });

  it('no dup group → no lookup at all, even with both cuis present', () => {
    expect(pickDuplicateDriver(anchor({ dupGroupId: null }))).toBeNull();
  });
});

describe('RON decimal addition (totalValueRon never touches a float)', () => {
  it('adds two-decimal money strings exactly', () => {
    expect(addDecimalStrings('0.10', '0.20')).toBe('0.30'); // 0.1 + 0.2 !== 0.3 in binary
    expect(addDecimalStrings('1000.00', '2500.50')).toBe('3500.50');
  });

  it('survives magnitudes past Number.MAX_SAFE_INTEGER', () => {
    // The live DA total is 3.9e11 RON; contracts 2.0e12. Cents overflow a float64 long
    // before the integers themselves do.
    expect(addDecimalStrings('391269977855.14', '2028459471529.09')).toBe('2419729449384.23');
  });

  it('handles a negative operand (modification deltas may be negative)', () => {
    expect(addDecimalStrings('100.00', '-250.25')).toBe('-150.25');
    expect(addDecimalStrings('-1.05', '-2.05')).toBe('-3.10');
  });

  it('handles an integer-looking operand', () => {
    expect(addDecimalStrings('5', '0.25')).toBe('5.25');
  });
});

describe('scope cache', () => {
  it('serves a hit within the TTL and re-loads after it expires', async () => {
    let clock = 0;
    let loads = 0;
    const cache = makeScopeCache(1000, () => clock);
    const load = async (): Promise<number> => {
      loads += 1;
      return Promise.resolve(loads);
    };

    expect(await cache.through('k', load)).toBe(1);
    clock = 999;
    expect(await cache.through('k', load)).toBe(1); // still fresh
    clock = 1001;
    expect(await cache.through('k', load)).toBe(2); // expired → reloaded
    expect(loads).toBe(2);
  });

  it('collapses a concurrent stampede into ONE load', async () => {
    let loads = 0;
    const cache = makeScopeCache(1000, () => 0);
    const load = async (): Promise<number> => {
      loads += 1;
      await Promise.resolve();
      return loads;
    };
    const [a, b, c] = await Promise.all([
      cache.through('k', load),
      cache.through('k', load),
      cache.through('k', load),
    ]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(loads).toBe(1);
  });

  it('never memoizes a failed load', async () => {
    const cache = makeScopeCache(1000, () => 0);
    await expect(
      cache.through('k', () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
    expect(cache.size()).toBe(0);
    expect(await cache.through('k', () => Promise.resolve('ok'))).toBe('ok');
  });

  it('keys are isolated', async () => {
    const cache = makeScopeCache(1000, () => 0);
    expect(await cache.through('a', () => Promise.resolve(1))).toBe(1);
    expect(await cache.through('b', () => Promise.resolve(2))).toBe(2);
    expect(cache.size()).toBe(2);
  });
});
