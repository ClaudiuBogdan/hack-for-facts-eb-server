/**
 * Cached Authentication Adapter
 *
 * Wraps any AuthProvider with an LRU cache to avoid repeated
 * expensive cryptographic verification of the same token.
 *
 * Security considerations:
 * - Uses SHA-256 hash of token as cache key (never stores raw token)
 * - Respects token expiration (cached entry expires with token)
 * - LRU eviction prevents memory bloat
 * - Cache is per-instance (no cross-request token leakage)
 */

import { ok, type Result } from 'neverthrow';

import type { AuthError } from '../../core/errors.js';
import type { AuthProvider } from '../../core/ports.js';
import type { AuthSession } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cached session entry with metadata.
 */
interface CachedSession {
  session: AuthSession;
  /** When this cache entry expires (min of token exp and cache TTL) */
  expiresAt: number;
}

/**
 * Options for creating a cached auth provider.
 */
export interface MakeCachedAuthProviderOptions {
  /**
   * The underlying auth provider to wrap.
   */
  provider: AuthProvider;

  /**
   * Maximum number of tokens to cache.
   * Oldest entries are evicted when limit is reached (LRU).
   * @default 1000
   */
  maxCacheSize?: number;

  /**
   * Cache TTL in milliseconds.
   * Entries expire after this time regardless of token expiration.
   * Should be shorter than typical token lifetime.
   * @default 300000 (5 minutes)
   */
  cacheTTLMs?: number;

  /**
   * Optional hash function for token hashing.
   * Defaults to SHA-256 using Web Crypto API.
   * Can be overridden for testing or alternative implementations.
   */
  hashToken?: (token: string) => Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Hash Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default token hash function using SHA-256.
 * Uses Web Crypto API (available in Node.js 15+).
 */
const defaultHashToken = async (token: string): Promise<string> => {
  // Use Node.js crypto module
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(token).digest('hex');
};

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple LRU cache using Map's insertion order.
 * When capacity is exceeded, oldest entries are removed.
 */
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // If key exists, delete first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value as K;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, value);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a cached auth provider that wraps another provider.
 *
 * Caches successful token verifications to avoid repeated crypto operations.
 * Cache keys are SHA-256 hashes of tokens (never stores raw tokens).
 *
 * @param options - Configuration including the underlying provider
 * @returns AuthProvider with caching
 *
 * @example
 * import { makeJWTAdapter, makeCachedAuthProvider } from '@/modules/auth';
 *
 * // Create base provider
 * const jwtProvider = makeJWTAdapter({
 *   jwtVerify,
 *   importSPKI,
 *   publicKeyPEM: process.env.CLERK_JWT_KEY!,
 * });
 *
 * // Wrap with cache
 * const authProvider = makeCachedAuthProvider({
 *   provider: jwtProvider,
 *   maxCacheSize: 1000,
 *   cacheTTLMs: 5 * 60 * 1000, // 5 minutes
 * });
 */
export const makeCachedAuthProvider = (options: MakeCachedAuthProviderOptions): AuthProvider => {
  const {
    provider,
    maxCacheSize = 1000,
    cacheTTLMs = 5 * 60 * 1000, // 5 minutes
    hashToken = defaultHashToken,
  } = options;

  const cache = new LRUCache<string, CachedSession>(maxCacheSize);

  return {
    async verifyToken(token: string): Promise<Result<AuthSession, AuthError>> {
      const now = Date.now();

      // Hash the token for cache lookup
      const tokenHash = await hashToken(token);

      // Check cache
      const cached = cache.get(tokenHash);
      if (cached !== undefined) {
        // Check if cache entry is still valid
        if (cached.expiresAt > now) {
          // Cache hit - return cached session
          return ok(cached.session);
        }
        // Cache entry expired - remove it
        cache.delete(tokenHash);
      }

      // Cache miss - verify with underlying provider
      const result = await provider.verifyToken(token);

      if (result.isOk()) {
        const session = result.value;

        // Calculate cache expiration (min of token exp and cache TTL)
        const tokenExpiresAt = session.expiresAt.getTime();
        const cacheExpiresAt = now + cacheTTLMs;
        const expiresAt = Math.min(tokenExpiresAt, cacheExpiresAt);

        // Only cache if expiration is in the future
        if (expiresAt > now) {
          cache.set(tokenHash, { session, expiresAt });
        }
      }

      // Note: We don't cache errors to allow retry with same token
      // (e.g., if provider had temporary issue)

      return result;
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Cache Statistics (for monitoring/debugging)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended cached provider with statistics.
 */
export interface CachedAuthProviderWithStats extends AuthProvider {
  /** Get current cache statistics */
  getStats(): CacheStats;
  /** Clear the cache */
  clearCache(): void;
}

/**
 * Cache statistics for monitoring.
 */
export interface CacheStats {
  /** Number of entries currently in cache */
  size: number;
  /** Total cache hits since creation */
  hits: number;
  /** Total cache misses since creation */
  misses: number;
  /** Hit rate as percentage (0-100) */
  hitRate: number;
}

/**
 * Creates a cached auth provider with statistics tracking.
 * Useful for monitoring cache effectiveness.
 */
export const makeCachedAuthProviderWithStats = (
  options: MakeCachedAuthProviderOptions
): CachedAuthProviderWithStats => {
  const {
    provider,
    maxCacheSize = 1000,
    cacheTTLMs = 5 * 60 * 1000,
    hashToken = defaultHashToken,
  } = options;

  const cache = new LRUCache<string, CachedSession>(maxCacheSize);
  let hits = 0;
  let misses = 0;

  return {
    async verifyToken(token: string): Promise<Result<AuthSession, AuthError>> {
      const now = Date.now();
      const tokenHash = await hashToken(token);

      const cached = cache.get(tokenHash);
      if (cached !== undefined && cached.expiresAt > now) {
        hits++;
        return ok(cached.session);
      }

      if (cached !== undefined) {
        cache.delete(tokenHash);
      }

      misses++;
      const result = await provider.verifyToken(token);

      if (result.isOk()) {
        const session = result.value;
        const tokenExpiresAt = session.expiresAt.getTime();
        const cacheExpiresAt = now + cacheTTLMs;
        const expiresAt = Math.min(tokenExpiresAt, cacheExpiresAt);

        if (expiresAt > now) {
          cache.set(tokenHash, { session, expiresAt });
        }
      }

      return result;
    },

    getStats(): CacheStats {
      const total = hits + misses;
      return {
        size: cache.size,
        hits,
        misses,
        hitRate: total > 0 ? (hits / total) * 100 : 0,
      };
    },

    clearCache(): void {
      cache.clear();
      hits = 0;
      misses = 0;
    },
  };
};
