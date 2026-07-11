import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeRedisMutationRateLimiter } from '@/modules/user-data/index.js';

import type { Redis } from 'ioredis';

describe('Redis mutation rate limiter', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the fixed minute key, expires it, and returns the next-minute retry delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:42.500Z'));
    const incr = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    const expire = vi.fn().mockResolvedValue(1);
    const limiter = makeRedisMutationRateLimiter({
      redis: { incr, expire } as unknown as Redis,
      logger: { warn: vi.fn() },
    });

    expect((await limiter.consume('owner', 'category', 2))._unsafeUnwrap()).toEqual({
      allowed: true,
    });
    expect((await limiter.consume('owner', 'category', 2))._unsafeUnwrap()).toEqual({
      allowed: false,
      retryAfterSeconds: 18,
    });
    expect(incr).toHaveBeenCalledWith('ud:rl:owner:category:29453760');
    expect(expire).toHaveBeenCalledOnce();
    expect(expire).toHaveBeenCalledWith('ud:rl:owner:category:29453760', 120);
  });

  it('fails open and warns once without logging owner, category, or payload data', async () => {
    const warn = vi.fn();
    const limiter = makeRedisMutationRateLimiter({
      redis: { incr: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as Redis,
      logger: { warn },
    });

    expect((await limiter.consume('secret-owner', 'secret-category', 1))._unsafeUnwrap()).toEqual({
      allowed: true,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-owner');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-category');
  });
});
