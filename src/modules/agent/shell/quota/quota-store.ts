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
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

const QUOTA_TTL_SECONDS = 48 * 60 * 60;

const utcDay = (): string => new Date().toISOString().slice(0, 10);

const quotaKey = (userId: string): string => `agent:quota:${userId}:${utcDay()}`;
const reservationKey = (userId: string): string => `agent:quota-reservation:${userId}:${utcDay()}`;

const storageError = (error: unknown): AgentError => ({
  type: 'STORAGE',
  message: error instanceof Error ? error.message : 'Unknown quota storage error',
});

const RESERVE_REMAINING_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local budget = tonumber(ARGV[1])
if budget <= 0 or current >= budget or redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
local reserved = budget - current
redis.call('SET', KEYS[1], budget, 'EX', ARGV[2])
redis.call('SET', KEYS[2], reserved, 'EX', ARGV[2])
return reserved
`;

const RECONCILE_RESERVATION_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
if reserved <= 0 then
  return current
end
local actual = tonumber(ARGV[1])
local adjusted = current - reserved + actual
if adjusted < 0 then
  adjusted = 0
end
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[1], adjusted, 'EX', ARGV[2])
return adjusted
`;

const parseRedisInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};

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

  async reserveRemaining(userId, budgetTokens) {
    try {
      const value = await redis.eval(
        RESERVE_REMAINING_SCRIPT,
        2,
        quotaKey(userId),
        reservationKey(userId),
        budgetTokens,
        QUOTA_TTL_SECONDS
      );
      const reserved = parseRedisInteger(value);
      if (reserved === null) {
        return err(storageError(new Error('Redis returned an invalid quota reservation')));
      }
      return ok(reserved < 0 ? null : reserved);
    } catch (error) {
      return err(storageError(error));
    }
  },

  async reconcileReservation(userId, reservedTokens, actualTokens) {
    if (reservedTokens <= 0) return ok(undefined);
    try {
      await redis.eval(
        RECONCILE_RESERVATION_SCRIPT,
        2,
        quotaKey(userId),
        reservationKey(userId),
        Math.max(actualTokens, 0),
        QUOTA_TTL_SECONDS
      );
      return ok(undefined);
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
  const reservations = new Map<string, number>();
  return {
    usedToday(userId) {
      return Promise.resolve(ok(counters.get(quotaKey(userId)) ?? 0));
    },
    reserveRemaining(userId, budgetTokens) {
      const key = quotaKey(userId);
      const reservedKey = reservationKey(userId);
      const current = counters.get(key) ?? 0;
      if (budgetTokens <= 0 || current >= budgetTokens || reservations.has(reservedKey)) {
        return Promise.resolve(ok(null));
      }
      const reserved = budgetTokens - current;
      counters.set(key, budgetTokens);
      reservations.set(reservedKey, reserved);
      return Promise.resolve(ok(reserved));
    },
    reconcileReservation(userId, reservedTokens, actualTokens) {
      if (reservedTokens <= 0) return Promise.resolve(ok(undefined));
      const key = quotaKey(userId);
      const reservedKey = reservationKey(userId);
      const storedReservation = reservations.get(reservedKey);
      if (storedReservation === undefined) return Promise.resolve(ok(undefined));
      const current = counters.get(key) ?? 0;
      counters.set(key, Math.max(current - storedReservation + Math.max(actualTokens, 0), 0));
      reservations.delete(reservedKey);
      return Promise.resolve(ok(undefined));
    },
    recordUsage(userId, tokens) {
      if (tokens <= 0) return Promise.resolve(ok(undefined));
      const key = quotaKey(userId);
      counters.set(key, (counters.get(key) ?? 0) + tokens);
      return Promise.resolve(ok(undefined));
    },
  };
};
