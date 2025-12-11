/**
 * Redis cache adapter using ioredis.
 */

import { Redis } from 'ioredis';
import { err, ok, type Result } from 'neverthrow';

import {
  CacheError as CacheErrorFactory,
  type CacheError,
  type CachePort,
  type CacheSetOptions,
  type CacheStats,
} from '../ports.js';
import { deserialize, serialize } from '../serialization.js';

export interface RedisCacheOptions {
  /** Redis connection URL */
  url: string;
  /** Key prefix for all cache keys. Default: 'transparenta' */
  keyPrefix?: string;
  /** Default TTL in milliseconds. Default: 3600000 (1 hour) */
  defaultTtlMs?: number;
  /** Connection timeout in milliseconds. Default: 5000 */
  connectTimeoutMs?: number;
  /** Command timeout in milliseconds. Default: 1000 */
  commandTimeoutMs?: number;
}

interface RedisCacheState {
  client: Redis;
  keyPrefix: string;
  defaultTtlMs: number;
  hits: number;
  misses: number;
}

/**
 * Wrap a Redis operation with error handling.
 */
const wrapRedisOp = async <T>(
  op: () => Promise<T>,
  errorMessage: string
): Promise<Result<T, CacheError>> => {
  try {
    const result = await op();
    return ok(result);
  } catch (cause) {
    if (cause instanceof Error) {
      if (cause.message.includes('ETIMEDOUT') || cause.message.includes('timeout')) {
        return err(CacheErrorFactory.timeout(errorMessage, cause));
      }
      if (
        cause.message.includes('ECONNREFUSED') ||
        cause.message.includes('ENOTFOUND') ||
        cause.message.includes('connection')
      ) {
        return err(CacheErrorFactory.connection(errorMessage, cause));
      }
    }
    return err(CacheErrorFactory.connection(errorMessage, cause));
  }
};

/**
 * Create a Redis cache adapter.
 * Delegates to createRedisCacheFromClient after instantiating the client.
 */
export const createRedisCache = <T>(options: RedisCacheOptions): CachePort<T> => {
  const client = new Redis(options.url, {
    connectTimeout: options.connectTimeoutMs ?? 5000,
    commandTimeout: options.commandTimeoutMs ?? 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times: number) => Math.min(times * 100, 30000),
    lazyConnect: true,
  });

  const fromClientOptions: { keyPrefix?: string; defaultTtlMs?: number } = {};
  if (options.keyPrefix !== undefined) {
    fromClientOptions.keyPrefix = options.keyPrefix;
  }
  if (options.defaultTtlMs !== undefined) {
    fromClientOptions.defaultTtlMs = options.defaultTtlMs;
  }

  return createRedisCacheFromClient(client, fromClientOptions);
};

/**
 * Create a Redis cache and return both the cache and the client for lifecycle management.
 */
export const createRedisCacheWithClient = <T>(
  options: RedisCacheOptions
): { cache: CachePort<T>; client: Redis } => {
  const keyPrefix = options.keyPrefix ?? 'transparenta';
  const defaultTtlMs = options.defaultTtlMs ?? 3600000;

  const client = new Redis(options.url, {
    connectTimeout: options.connectTimeoutMs ?? 5000,
    commandTimeout: options.commandTimeoutMs ?? 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times: number) => Math.min(times * 100, 30000),
    lazyConnect: true,
  });

  // Create cache using the client
  const cache = createRedisCacheFromClient<T>(client, {
    keyPrefix,
    defaultTtlMs,
  });

  return { cache, client };
};

/**
 * Create a Redis cache from an existing client.
 */
export const createRedisCacheFromClient = <T>(
  client: Redis,
  options: { keyPrefix?: string; defaultTtlMs?: number }
): CachePort<T> => {
  const keyPrefix = options.keyPrefix ?? 'transparenta';
  const defaultTtlMs = options.defaultTtlMs ?? 3600000;

  const state: RedisCacheState = {
    client,
    keyPrefix,
    defaultTtlMs,
    hits: 0,
    misses: 0,
  };

  const buildKey = (key: string): string => {
    if (key.startsWith(`${keyPrefix}:`)) {
      return key;
    }
    return `${keyPrefix}:${key}`;
  };

  return {
    async get(key: string) {
      const fullKey = buildKey(key);

      const result = await wrapRedisOp(() => client.get(fullKey), `Failed to get key: ${key}`);

      if (result.isErr()) {
        return err(result.error);
      }

      const value = result.value;
      if (value === null) {
        state.misses++;
        return ok(undefined);
      }

      const deserialized = deserialize(value);
      if (!deserialized.ok) {
        state.misses++;
        return err(deserialized.error);
      }

      state.hits++;
      return ok(deserialized.value as T);
    },

    async set(key: string, value: T, setOptions?: CacheSetOptions) {
      const fullKey = buildKey(key);
      const ttlMs = setOptions?.ttlMs ?? defaultTtlMs;
      const serialized = serialize(value);

      const result = await wrapRedisOp(
        () => client.set(fullKey, serialized, 'PX', ttlMs),
        `Failed to set key: ${key}`
      );

      if (result.isErr()) {
        return err(result.error);
      }

      return ok(undefined);
    },

    async delete(key: string) {
      const fullKey = buildKey(key);

      const result = await wrapRedisOp(() => client.del(fullKey), `Failed to delete key: ${key}`);

      if (result.isErr()) {
        return err(result.error);
      }

      return ok(result.value > 0);
    },

    async has(key: string) {
      const fullKey = buildKey(key);

      const result = await wrapRedisOp(
        () => client.exists(fullKey),
        `Failed to check key existence: ${key}`
      );

      if (result.isErr()) {
        return err(result.error);
      }

      return ok(result.value > 0);
    },

    async clearByPrefix(prefix: string) {
      const fullPrefix = buildKey(prefix);
      let cursor = '0';
      let totalDeleted = 0;

      const scanResult = await wrapRedisOp(async () => {
        do {
          const [nextCursor, keys] = await client.scan(
            cursor,
            'MATCH',
            `${fullPrefix}*`,
            'COUNT',
            100
          );
          cursor = nextCursor;

          if (keys.length > 0) {
            const deleted = await client.del(...keys);
            totalDeleted += deleted;
          }
        } while (cursor !== '0');

        return totalDeleted;
      }, `Failed to clear by prefix: ${prefix}`);

      if (scanResult.isErr()) {
        return err(scanResult.error);
      }

      return ok(scanResult.value);
    },

    async clear() {
      const result = await wrapRedisOp(async () => {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await client.scan(
            cursor,
            'MATCH',
            `${keyPrefix}:*`,
            'COUNT',
            100
          );
          cursor = nextCursor;

          if (keys.length > 0) {
            await client.del(...keys);
          }
        } while (cursor !== '0');
      }, 'Failed to clear cache');

      if (result.isErr()) {
        return err(result.error);
      }

      state.hits = 0;
      state.misses = 0;

      return ok(undefined);
    },

    stats(): Promise<CacheStats> {
      // Note: We intentionally skip counting keys via SCAN.
      // SCAN is expensive on large Redis instances and can cause
      // performance issues if called frequently (e.g., health checks).
      // Hits/misses are tracked in-memory and are sufficient for monitoring.
      return Promise.resolve({ hits: state.hits, misses: state.misses, size: 0 });
    },
  };
};
