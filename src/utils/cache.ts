import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { config } from '../config';

// --- Interfaces and Types for Cache Configuration ---
interface CacheOptions {
    name: string;
    maxSize: number; // Maximum size of the cache in bytes
    maxItems: number; // Maximum number of items in the cache
    ttl: number; // Time to live in milliseconds
}

// --- Cache Configuration ---
const defaultOptions: CacheOptions = {
    name: 'default',
    maxSize: 10 * 1024 * 1024, // 10MB
    maxItems: 1000,
    ttl: 1000 * 60 * 60 * 24 * 7, // 1 week
};

// --- Helper function to calculate the size of a cache entry. Simplified implementation for simple key-value pairs of strings ---
const sizeCalculation = (value: any, key: string): number => {
    const valueSize = Buffer.from(JSON.stringify(value)).length;
    const keySize = Buffer.from(key).length;
    const totalSize = valueSize + keySize;
    if (process.env.CACHE_DEBUG === 'true') {
        console.log(`Size of ${key}: ${totalSize} bytes`);
    }
    return totalSize;
};

// Factory function to create a cache instance
export function createCache<T extends Record<string, any> = any>(options?: Partial<CacheOptions>) {
    const merged = { ...defaultOptions, ttl: config.cache.ttlMs, ...options } as CacheOptions;
    const { maxSize, maxItems, ttl, name } = merged;
    if (process.env.CACHE_DEBUG === 'true') {
        console.log(`Creating cache '${name}' with maxSize: ${maxSize} bytes, maxItems: ${maxItems}, ttl: ${ttl} ms`);
    }
    // Allow disabling caches globally via config
    if (!config.cache.enabled) {
        // Provide a no-op cache with the same interface subset we use
        const noop = new Map<string, T>();
        return {
            get: (key: string) => noop.get(key),
            set: (key: string, value: T) => { noop.set(key, value); return true; },
            delete: (key: string) => noop.delete(key),
            has: (key: string) => noop.has(key),
            clear: () => noop.clear(),
        } as unknown as LRUCache<string, T>;
    }

    const cache = new LRUCache<string, T>({
        max: maxItems,
        maxSize: Math.min(maxSize, config.cache.maxSizeBytes),
        ttl,
        sizeCalculation,
    });

    return cache
};

// --- Helper function to recursively sort object keys ---
const sortObjectKeys = (obj: any): any => {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(sortObjectKeys);
    }
    const sortedKeys = Object.keys(obj).sort();
    const sortedObj: { [key: string]: any } = {};
    for (const key of sortedKeys) {
        sortedObj[key] = sortObjectKeys(obj[key]);
    }
    return sortedObj;
};

// --- Function to generate a stable cache key ---
export const getCacheKey = (data: Record<string, any>): string => {
    const sortedData = sortObjectKeys(data);
    const stringifiedData = JSON.stringify(sortedData);
    const hash = createHash('sha256');
    hash.update(stringifiedData);
    return hash.digest('hex');
}; 