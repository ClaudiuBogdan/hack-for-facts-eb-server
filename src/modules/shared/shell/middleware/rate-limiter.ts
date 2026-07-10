/**
 * Shared Kernel — token-bucket rate limiter (foundation §4.6).
 *
 * In-process, per-key (per-IP) token bucket for AI/expensive endpoints. No
 * external dependency. Stale buckets are reaped periodically.
 */

export interface RateLimiterConfig {
  readonly maxTokens: number;
  readonly windowMs: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  readonly remaining: number;
}

export interface RateLimiter {
  consume(key: string): RateLimitResult;
}

export const createRateLimiter = (config: RateLimiterConfig): RateLimiter => {
  const buckets = new Map<string, Bucket>();

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.lastRefill > config.windowMs * 2) buckets.delete(k);
  }, 60_000);
  if (typeof interval === 'object' && 'unref' in interval) interval.unref();

  const refill = (b: Bucket): void => {
    const now = Date.now();
    const elapsed = now - b.lastRefill;
    b.tokens = Math.min(
      config.maxTokens,
      b.tokens + (elapsed / config.windowMs) * config.maxTokens
    );
    b.lastRefill = now;
  };

  return {
    consume(key: string): RateLimitResult {
      let b = buckets.get(key);
      if (b === undefined) {
        b = { tokens: config.maxTokens, lastRefill: Date.now() };
        buckets.set(key, b);
      }
      refill(b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, retryAfterMs: 0, remaining: Math.floor(b.tokens) };
      }
      const retryAfterMs = Math.ceil(((1 - b.tokens) / config.maxTokens) * config.windowMs);
      return { allowed: false, retryAfterMs, remaining: 0 };
    },
  };
};
