import { ok } from 'neverthrow';

import type { MutationRateLimiterPort } from '../../core/ports.js';
import type { Redis } from 'ioredis';

export interface MutationRateLimiterLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

export const makeRedisMutationRateLimiter = (deps: {
  redis: Redis;
  logger: MutationRateLimiterLogger;
}): MutationRateLimiterPort => ({
  async consume(ownerId, category, limitPerMinute) {
    const now = Date.now();
    const epochMinute = Math.floor(now / 60_000);
    const key = `ud:rl:${ownerId}:${category}:${String(epochMinute)}`;
    try {
      const count = await deps.redis.incr(key);
      if (count === 1) await deps.redis.expire(key, 120);
      if (count > limitPerMinute) {
        const retryAfterSeconds = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
        return ok({ allowed: false as const, retryAfterSeconds });
      }
      return ok({ allowed: true as const });
    } catch (error) {
      deps.logger.warn(
        { err: error instanceof Error ? error.message : 'Redis operation failed' },
        'User-data mutation rate limiter failed open'
      );
      return ok({ allowed: true as const });
    }
  },
});
