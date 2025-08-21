import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { config } from '../config';
import type Redis from 'ioredis';

const logger = console;

// --- Interfaces and Types ---
export interface AsyncCache<T> {
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T, ttlMsOverride?: number): Promise<boolean>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    clear(): Promise<void>;
}

interface CacheOptions {
    name: string;
    maxSize: number; // Maximum size of the cache in bytes
    maxItems: number; // Maximum number of items in the cache
    ttl: number; // Default time to live in milliseconds
    strategy?: CacheStrategy; // Optional cache strategy
}

export type CacheStrategy = 'L1_L2' | 'L1_ONLY' | 'L2_ONLY';

// --- Default Configuration ---
const defaultOptions: CacheOptions = {
    name: 'default',
    maxSize: 10 * 1024 * 1024, // 10MB
    maxItems: 1000,
    ttl: 1000 * 60 * 60 * 24 * 7, // 1 week
};

// --- Helper Functions ---

const sizeCalculation = <T>(value: T, key: string): number => {
    const valueSize = Buffer.from(JSON.stringify(value)).length;
    const keySize = Buffer.from(key).length;
    return valueSize + keySize;
};

let redisClientSingleton: Redis | null = null;
async function getRedisClient(): Promise<Redis | null> {
    if (redisClientSingleton) return redisClientSingleton;
    try {
        // Lazily import ioredis
        const { default: RedisCtor } = await import('ioredis');
        const client = new RedisCtor(config.cache.redis.url);
        client.on('error', (err) => {
            logger.error({ err }, 'Redis connection error');
        });
        redisClientSingleton = client;
        return client;
    } catch (err) {
        logger.warn({ err }, 'Redis client not available. Falling back to in-memory cache.');
        return null;
    }
}

// --- Cache Implementation Builders ---

function createL1Cache<T extends object>(options: CacheOptions): AsyncCache<T> {
    const { maxItems, maxSize, ttl } = options;
    const lru = new LRUCache<string, T>({
        max: maxItems,
        maxSize,
        ttl,
        sizeCalculation,
    });
    return {
        get: async (key) => lru.get(key),
        set: async (key, value, ttlMsOverride) => {
            lru.set(key, value, { ttl: ttlMsOverride });
            return true;
        },
        has: async (key) => lru.has(key),
        delete: async (key) => lru.delete(key),
        clear: async () => lru.clear(),
    };
}

async function createL2Cache<T extends object>(options: CacheOptions): Promise<AsyncCache<T> | null> {
    const client = await getRedisClient();
    if (!client) return null;

    const { name, ttl: defaultTtlMs } = options;
    const prefix = `${config.cache.redis.prefix}:${name}::`;

    return {
        async get(key: string): Promise<T | undefined> {
            try {
                const raw = await client.get(prefix + key);
                return raw ? (JSON.parse(raw) as T) : undefined;
            } catch (err) {
                logger.error({ name, key, err }, 'Redis GET error');
                return undefined;
            }
        },
        async set(key: string, value: T, ttlMsOverride?: number): Promise<boolean> {
            try {
                const ttlSec = Math.max(1, Math.floor((ttlMsOverride ?? defaultTtlMs) / 1000));
                await client.set(prefix + key, JSON.stringify(value), 'EX', ttlSec);
                return true;
            } catch (err) {
                logger.error({ name, key, err }, 'Redis SET error');
                return false;
            }
        },
        async has(key: string): Promise<boolean> {
            try {
                return (await client.exists(prefix + key)) === 1;
            } catch (err) {
                logger.error({ name, key, err }, 'Redis EXISTS error');
                return false;
            }
        },
        async delete(key: string): Promise<boolean> {
            try {
                return (await client.del(prefix + key)) > 0;
            } catch (err) {
                logger.error({ name, key, err }, 'Redis DEL error');
                return false;
            }
        },
        async clear(): Promise<void> {
            try {
                const stream = client.scanStream({ match: `${prefix}*`, count: 100 });
                for await (const keys of stream) {
                    if (keys.length) {
                        await client.del(keys as string[]);
                    }
                }
            } catch (err) {
                logger.error({ name, err }, 'Redis SCAN/DEL clear error');
            }
        },
    };
}

// --- Cache Strategy Composers ---

function createL2Proxy<T extends object>(l2Promise: Promise<AsyncCache<T> | null>): AsyncCache<T> {
    return {
        get: async (key) => { const l2 = await l2Promise; return l2 ? l2.get(key) : undefined; },
        set: async (key, value, ttl) => { const l2 = await l2Promise; return l2 ? l2.set(key, value, ttl) : false; },
        has: async (key) => { const l2 = await l2Promise; return l2 ? l2.has(key) : false; },
        delete: async (key) => { const l2 = await l2Promise; return l2 ? l2.delete(key) : false; },
        clear: async () => { const l2 = await l2Promise; if (l2) await l2.clear(); },
    };
}

function createComposedCache<T extends object>(l1: AsyncCache<T>, l2Promise: Promise<AsyncCache<T> | null>): AsyncCache<T> {
    return {
        async get(key: string): Promise<T | undefined> {
            const fromL1 = await l1.get(key);
            if (fromL1 !== undefined) return fromL1;

            const l2 = await l2Promise;
            if (!l2) return undefined;

            const fromL2 = await l2.get(key);
            if (fromL2 !== undefined) {
                await l1.set(key, fromL2); // Populate L1 on L2 hit
            }
            return fromL2;
        },
        async set(key: string, value: T, ttlMsOverride?: number): Promise<boolean> {
            const l2 = await l2Promise;
            // Set L1 and L2 concurrently
            const results = await Promise.all([
                l1.set(key, value, ttlMsOverride),
                l2?.set(key, value, ttlMsOverride)
            ]);
            // Succeeds if L1 succeeds (L2 is best-effort)
            return results[0];
        },
        async has(key: string): Promise<boolean> {
            if (await l1.has(key)) return true;
            const l2 = await l2Promise;
            return l2 ? l2.has(key) : false;
        },
        async delete(key: string): Promise<boolean> {
            const l2 = await l2Promise;
            // Delete from L1 and L2 concurrently
            const [l1Deleted, l2Deleted] = await Promise.all([
                l1.delete(key),
                l2?.delete(key)
            ]);
            // Return true if it was deleted from either cache
            return l1Deleted || (l2Deleted ?? false);
        },
        async clear(): Promise<void> {
            const l2 = await l2Promise;
            await Promise.all([l1.clear(), l2?.clear()]);
        },
    };
}

// --- Main Cache Factory ---
export function createCache<T extends Record<string, any> = any>(options?: Partial<CacheOptions>): AsyncCache<T> {
    const merged = { ...defaultOptions, ttl: config.cache.ttlMs, strategy: 'L1_L2', ...options } as CacheOptions;
    logger.info(`Creating cache '${merged.name}' with strategy: ${merged.strategy}`);

    if (!config.cache.enabled) {
        logger.warn("Cache is globally disabled. Using a non-caching Map instance.");
        const store = new Map<string, T>();
        return {
            get: async (key) => store.get(key),
            set: async (key, value) => { store.set(key, value); return true; },
            delete: async (key) => store.delete(key),
            has: async (key) => store.has(key),
            clear: async () => store.clear(),
        };
    }

    const l1Cache = createL1Cache<T>(merged);

    // If L1 is all that's needed, return early.
    if (merged.strategy === 'L1_ONLY' || !config.cache.redis.enabled) {
        return l1Cache;
    }

    const l2CachePromise = createL2Cache<T>(merged);

    switch (merged.strategy) {
        case 'L2_ONLY':
            return createL2Proxy(l2CachePromise);
        case 'L1_L2':
        default:
            return createComposedCache(l1Cache, l2CachePromise);
    }
}


// --- Stable Cache Key Generation ---

const sortObjectKeys = (obj: any): any => {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);

    return Object.keys(obj)
        .sort()
        .reduce((acc, key) => {
            acc[key] = sortObjectKeys(obj[key]);
            return acc;
        }, {} as { [key: string]: any });
};

export const getCacheKey = (data: Record<string, any>): string => {
    const sortedData = sortObjectKeys(data);
    const stringifiedData = JSON.stringify(sortedData);
    return createHash('sha256').update(stringifiedData).digest('hex');
};