import { describe, expect, it, vi } from 'vitest';

import { makeSearchAccessCache } from '@/modules/companies/shell/search-access-cache.js';

import type { SearchAccessSnapshot } from '@/modules/shared/core/ports.js';

const snapshot: SearchAccessSnapshot = {
  scopeKey: 'onrc:published:42:3:17',
  published: true,
  privateCuis: new Set(['123']),
  privateInstitutionCuis: new Set<string>(),
};

describe('background search access snapshot', () => {
  it('expires at 180 seconds from acquisition start, not completion', async () => {
    let now = 0;
    const cache = makeSearchAccessCache(
      async () => {
        now = 30_000;
        return snapshot;
      },
      { autoStart: false, monotonicNow: () => now, wallNow: () => now }
    );
    expect(cache.read()).toBeNull();
    await cache.refresh();
    now = 179_999;
    expect(cache.read()).toBe(snapshot);
    now = 180_000;
    expect(cache.read()).toBeNull();
    cache.close();
  });
  it('failed refreshes never extend the lifetime or replace the policy with an empty set', async () => {
    let now = 0;
    let fail = false;
    const cache = makeSearchAccessCache(
      async () => {
        if (fail) throw new Error('failed');
        return snapshot;
      },
      { autoStart: false, monotonicNow: () => now, wallNow: () => now }
    );
    await cache.refresh();
    fail = true;
    now = 120_000;
    await cache.refresh();
    expect(cache.read()?.privateCuis.has('123')).toBe(true);
    now = 180_000;
    expect(cache.read()).toBeNull();
    cache.close();
  });
  it('singleflights refreshes and cannot install a result after close', async () => {
    let finish!: (v: SearchAccessSnapshot) => void;
    const load = vi.fn(
      () =>
        new Promise<SearchAccessSnapshot>((resolve) => {
          finish = resolve;
        })
    );
    const cache = makeSearchAccessCache(load, { autoStart: false });
    const first = cache.refresh();
    const second = cache.refresh();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    cache.close();
    finish(snapshot);
    await first;
    expect(cache.read()).toBeNull();
    await cache.refresh();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('fails closed on a clock discontinuity and captures a synchronous loader failure', async () => {
    let mono = 0;
    let wall = 0;
    const cache = makeSearchAccessCache(async () => snapshot, {
      autoStart: false,
      monotonicNow: () => mono,
      wallNow: () => wall,
    });
    await cache.refresh();
    mono = 1_000;
    wall = 10_000;
    expect(cache.read()).toBeNull();
    cache.close();
    const onError = vi.fn();
    const broken = makeSearchAccessCache(
      () => {
        throw new Error('sync');
      },
      { autoStart: false, onError }
    );
    await expect(broken.refresh()).resolves.toBeUndefined();
    expect(broken.read()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    broken.close();
  });
});
