/**
 * Quota stores (docs/AGENT-MODULE-SPEC.md §2.7) — daily per-user token counters.
 *
 * Redis-backed in real deployments (key `agent:quota:{userId}:{yyyy-mm-dd}`,
 * 48h TTL so yesterday's key expires on its own). The in-memory variant backs
 * tests and Redis-less dev boots; it is process-local and resets on restart.
 */

import { err, ok } from 'neverthrow';

import type { AgentError } from '../../core/errors.js';
import type { QuotaStore } from '../../core/ports.js';

/** Minimal Redis command surface the store needs (satisfied by ioredis). */
export interface QuotaRedis {
  get(key: string): Promise<string | null>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

const QUOTA_TTL_SECONDS = 48 * 60 * 60;

const utcDay = (): string => new Date().toISOString().slice(0, 10);

const quotaKey = (userId: string): string => `agent:quota:${userId}:${utcDay()}`;

const storageError = (error: unknown): AgentError => ({
  type: 'STORAGE',
  message: error instanceof Error ? error.message : 'Unknown quota storage error',
});

export const makeRedisQuotaStore = (redis: QuotaRedis): QuotaStore => ({
  async usedToday(userId) {
    try {
      const value = await redis.get(quotaKey(userId));
      const parsed = value === null ? 0 : Number.parseInt(value, 10);
      return ok(Number.isFinite(parsed) ? parsed : 0);
    } catch (error) {
      return err(storageError(error));
    }
  },

  async recordUsage(userId, tokens) {
    if (tokens <= 0) return ok(undefined);
    try {
      const key = quotaKey(userId);
      await redis.incrby(key, tokens);
      await redis.expire(key, QUOTA_TTL_SECONDS);
      return ok(undefined);
    } catch (error) {
      return err(storageError(error));
    }
  },
});

export const makeInMemoryQuotaStore = (): QuotaStore => {
  const counters = new Map<string, number>();
  return {
    usedToday(userId) {
      return Promise.resolve(ok(counters.get(quotaKey(userId)) ?? 0));
    },
    recordUsage(userId, tokens) {
      if (tokens <= 0) return Promise.resolve(ok(undefined));
      const key = quotaKey(userId);
      counters.set(key, (counters.get(key) ?? 0) + tokens);
      return Promise.resolve(ok(undefined));
    },
  };
};
