import { describe, expect, it } from 'vitest';

import { computeNextAttemptAt } from '@/modules/notification-platform/core/delivery/retry-policy.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const FIRST_ATTEMPT_AT = NOW;

const getDelayMs = (attemptNumber: number, jitterSeed = 42): number => {
  const result = computeNextAttemptAt({
    attemptNumber,
    now: NOW,
    firstAttemptAt: FIRST_ATTEMPT_AT,
    jitterSeed,
  });
  expect('nextAttemptAt' in result).toBe(true);
  return 'nextAttemptAt' in result ? result.nextAttemptAt.getTime() - NOW.getTime() : 0;
};

describe('computeNextAttemptAt', () => {
  it('grows retry delays exponentially by a factor of four', () => {
    const first = getDelayMs(1);
    const second = getDelayMs(2);
    const third = getDelayMs(3);
    const fourth = getDelayMs(4);

    expect(second).toBe(first * 4);
    expect(third).toBe(second * 4);
    expect(fourth).toBe(third * 4);
  });

  it('keeps computed backoff below the four-hour cap', () => {
    expect(getDelayMs(4, 99)).toBeLessThanOrEqual(4 * 60 * 60 * 1000);
  });

  it('applies deterministic jitter within plus or minus twenty percent', () => {
    const first = getDelayMs(1, 1234);
    const again = getDelayMs(1, 1234);
    const other = getDelayMs(1, 5678);

    expect(first).toBe(again);
    expect(first).toBeGreaterThanOrEqual(24_000);
    expect(first).toBeLessThanOrEqual(36_000);
    expect(other).toBeGreaterThanOrEqual(24_000);
    expect(other).toBeLessThanOrEqual(36_000);
    expect(other).not.toBe(first);
  });

  it('uses retry-after as a floor', () => {
    const result = computeNextAttemptAt({
      attemptNumber: 1,
      now: NOW,
      firstAttemptAt: FIRST_ATTEMPT_AT,
      retryAfterMs: 600_000,
      jitterSeed: 1,
    });

    expect(result).toEqual({ nextAttemptAt: new Date('2026-01-01T00:10:00.000Z') });
  });

  it('lets expiry take precedence over retry-after', () => {
    const result = computeNextAttemptAt({
      attemptNumber: 1,
      now: NOW,
      firstAttemptAt: FIRST_ATTEMPT_AT,
      retryAfterMs: 600_000,
      expiresAt: new Date('2026-01-01T00:05:00.000Z'),
      jitterSeed: 1,
    });

    expect(result).toEqual({ exhausted: true });
  });

  it('permits a retry exactly at expiry', () => {
    const result = computeNextAttemptAt({
      attemptNumber: 1,
      now: NOW,
      firstAttemptAt: FIRST_ATTEMPT_AT,
      retryAfterMs: 300_000,
      expiresAt: new Date('2026-01-01T00:05:00.000Z'),
      jitterSeed: 1,
    });

    expect(result).toEqual({ nextAttemptAt: new Date('2026-01-01T00:05:00.000Z') });
  });

  it('is exhausted when the next attempt would land beyond 24h from the first attempt', () => {
    const lateNow = new Date(FIRST_ATTEMPT_AT.getTime() + 24 * 60 * 60 * 1000 - 60_000);
    const result = computeNextAttemptAt({
      attemptNumber: 2,
      now: lateNow,
      firstAttemptAt: FIRST_ATTEMPT_AT,
      jitterSeed: 1,
    });

    expect(result).toEqual({ exhausted: true });
  });

  it('caps a large provider retry-after at the 24h window even without a kind expiry', () => {
    const result = computeNextAttemptAt({
      attemptNumber: 1,
      now: NOW,
      firstAttemptAt: FIRST_ATTEMPT_AT,
      retryAfterMs: 25 * 60 * 60 * 1000,
      jitterSeed: 1,
    });

    expect(result).toEqual({ exhausted: true });
  });

  it('is exhausted at attempt five', () => {
    expect(
      computeNextAttemptAt({
        attemptNumber: 5,
        now: NOW,
        firstAttemptAt: FIRST_ATTEMPT_AT,
        jitterSeed: 1,
      })
    ).toEqual({
      exhausted: true,
    });
  });
});
