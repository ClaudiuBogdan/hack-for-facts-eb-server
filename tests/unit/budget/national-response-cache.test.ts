import { describe, expect, it } from 'vitest';

import {
  NATIONAL_CACHE_MAX_RESPONSE_BYTES,
  NATIONAL_CACHE_MAX_RESPONSES,
  makeNationalResponseCache,
} from '@/modules/budget/shell/repo/national-read-port.js';

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * A complete DTO-shaped payload of exactly `bytes` UTF-8 JSON bytes: a few
 * exact decimal strings and dense gaps, and nested metadata (Romanian
 * multibyte text) far larger than the numeric data.
 */
const payloadOf = (bytes: number, tag = 'p') => {
  const make = (pad: number, ascii: number) => ({
    snapshot: `execution:${tag}`,
    results: [
      {
        item: { itemId: 'mfin.bgc.revenue.total', label: 'Venituri totale' },
        series: {
          frequency: 'MONTH',
          data: [
            { date: '2025-01', value: '59990900000.00' },
            { date: '2025-02', value: null },
            { date: '2025-03', value: '-0.01' },
          ],
        },
        evidence: { documents: [{ title: 'ă'.repeat(pad) + 'a'.repeat(ascii) }] },
      },
    ],
  });
  const base = bytesOf(make(0, 0));
  const room = bytes - base;
  // Two bytes per 'ă'; one optional ASCII byte for odd sizes.
  const value = make(Math.floor(room / 2), room % 2);
  expect(bytesOf(value)).toBe(bytes);
  return value;
};

const stamp = (cache: ReturnType<typeof makeNationalResponseCache>) => cache.begin();

describe('national response cache bounds', () => {
  it('admits a complete payload of exactly 262144 UTF-8 JSON bytes and refuses 262145', () => {
    expect(NATIONAL_CACHE_MAX_RESPONSE_BYTES).toBe(262_144);
    const cache = makeNationalResponseCache();
    const admitted = payloadOf(262_144, 'a');
    const refused = payloadOf(262_145, 'b');
    // Character counting would admit both: the multibyte text is ~half the characters.
    expect(JSON.stringify(refused).length).toBeLessThan(262_144);
    // The numeric data alone is tiny; only the nested metadata pushes it over.
    expect(bytesOf(refused.results[0]?.series)).toBeLessThan(200);
    cache.set('a', admitted, stamp(cache));
    cache.set('b', refused, stamp(cache));
    expect(cache.get('a')).toBe(admitted);
    expect(cache.get('b')).toBeUndefined();
  });

  it('retains at most 64 responses (kernel insertion-order eviction)', () => {
    expect(NATIONAL_CACHE_MAX_RESPONSES).toBe(64);
    const cache = makeNationalResponseCache();
    for (let index = 0; index < 65; index++)
      cache.set(`k${String(index)}`, { index }, stamp(cache));
    const retained = Array.from({ length: 65 }, (_, index) =>
      cache.get(`k${String(index)}`)
    ).filter((value) => value !== undefined);
    expect(retained).toHaveLength(64);
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('k64')).toEqual({ index: 64 });
  });

  it('accepts smaller limits but clamps larger overrides to the hard caps', () => {
    const wide = makeNationalResponseCache({ maxResponses: 1_000, maxResponseBytes: 10_000_000 });
    for (let index = 0; index < 100; index++) wide.set(`k${String(index)}`, { index }, stamp(wide));
    const retained = Array.from({ length: 100 }, (_, index) =>
      wide.get(`k${String(index)}`)
    ).filter((value) => value !== undefined);
    expect(retained).toHaveLength(64);
    wide.set('big', payloadOf(262_145), stamp(wide));
    expect(wide.get('big')).toBeUndefined();

    const narrow = makeNationalResponseCache({ maxResponses: 2, maxResponseBytes: 1_000 });
    narrow.set('x', payloadOf(1_000, 'x'), stamp(narrow));
    narrow.set('y', payloadOf(1_001, 'y'), stamp(narrow));
    expect(narrow.get('x')).toBeDefined();
    expect(narrow.get('y')).toBeUndefined();
    narrow.set('z1', { z: 1 }, stamp(narrow));
    narrow.set('z2', { z: 2 }, stamp(narrow));
    expect(narrow.get('x')).toBeUndefined();
  });

  it('skips oversized or unserialisable payloads without evicting, altering or throwing', () => {
    const cache = makeNationalResponseCache();
    for (let index = 0; index < 64; index++)
      cache.set(`k${String(index)}`, { index }, stamp(cache));
    const oversized = payloadOf(2_183_313, 'grid');
    const before = structuredClone(oversized);
    cache.set('oversized', oversized, stamp(cache));
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => {
      cache.set('circular', circular, stamp(cache));
      cache.set('bigint', { value: 1n }, stamp(cache));
    }).not.toThrow();
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.get('circular')).toBeUndefined();
    expect(cache.get('bigint')).toBeUndefined();
    expect(oversized).toEqual(before);
    for (let index = 0; index < 64; index++)
      expect(cache.get(`k${String(index)}`)).toEqual({ index });
  });

  it('still records the read-start probe when the response itself is refused', () => {
    let now = 0;
    const cache = makeNationalResponseCache({ clock: () => now });
    const older = cache.begin();
    const newer = cache.begin();
    cache.set('oversized', payloadOf(262_145), newer);
    cache.remember('EXECUTION', 'execution:new', newer);
    cache.remember('EXECUTION', 'execution:old', older);
    expect(cache.probe('EXECUTION')).toBe('execution:new');
    now = 30_000;
    expect(cache.probe('EXECUTION')).toBeUndefined();
  });

  it('keeps retained entries and serialised bytes bounded under churn', () => {
    const cache = makeNationalResponseCache();
    const keys: string[] = [];
    for (let index = 0; index < 300; index++) {
      const key = `max${String(index)}`;
      keys.push(key);
      cache.set(key, payloadOf(NATIONAL_CACHE_MAX_RESPONSE_BYTES, String(index)), stamp(cache));
      if (index % 3 === 0) {
        keys.push(`large${String(index)}`);
        cache.set(
          `large${String(index)}`,
          payloadOf(NATIONAL_CACHE_MAX_RESPONSE_BYTES + 1),
          stamp(cache)
        );
      }
    }
    const retained = keys.map((key) => cache.get(key)).filter((value) => value !== undefined);
    const retainedBytes = retained.reduce<number>((sum, value) => sum + bytesOf(value), 0);
    expect(retained).toHaveLength(64);
    expect(retainedBytes).toBe(64 * NATIONAL_CACHE_MAX_RESPONSE_BYTES); // 16 MiB serialised
  });
});
