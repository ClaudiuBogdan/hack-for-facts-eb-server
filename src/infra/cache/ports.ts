/**
 * Cache port interfaces using Result pattern for explicit error handling.
 */

import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export type CacheError =
  | { type: 'ConnectionError'; message: string; cause?: unknown }
  | { type: 'SerializationError'; message: string; cause?: unknown }
  | { type: 'TimeoutError'; message: string; cause?: unknown };

export const CacheError = {
  connection: (message: string, cause?: unknown): CacheError => ({
    type: 'ConnectionError',
    message,
    cause,
  }),
  serialization: (message: string, cause?: unknown): CacheError => ({
    type: 'SerializationError',
    message,
    cause,
  }),
  timeout: (message: string, cause?: unknown): CacheError => ({
    type: 'TimeoutError',
    message,
    cause,
  }),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheSetOptions {
  /** TTL in milliseconds. If undefined, uses adapter default. */
  ttlMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache Statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CachePort (Low-Level / Adapter Interface)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Low-level cache interface for implementing backends.
 * Uses Result pattern for explicit error handling.
 */
export interface CachePort<T = unknown> {
  /**
   * Retrieve a value by key.
   * @returns Ok(value) if found, Ok(undefined) if not found, Err on failure
   */
  get(key: string): Promise<Result<T | undefined, CacheError>>;

  /**
   * Store a value with optional TTL.
   */
  set(key: string, value: T, options?: CacheSetOptions): Promise<Result<void, CacheError>>;

  /**
   * Delete a specific key.
   * @returns Ok(true) if deleted, Ok(false) if key didn't exist
   */
  delete(key: string): Promise<Result<boolean, CacheError>>;

  /**
   * Check if a key exists (and is not expired).
   */
  has(key: string): Promise<Result<boolean, CacheError>>;

  /**
   * Delete all keys matching a prefix.
   * Used for namespace-based invalidation.
   * @returns Number of keys deleted
   */
  clearByPrefix(prefix: string): Promise<Result<number, CacheError>>;

  /**
   * Delete all cache entries.
   */
  clear(): Promise<Result<void, CacheError>>;

  /**
   * Get cache statistics for monitoring.
   */
  stats(): Promise<CacheStats>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SilentCachePort (Application Interface)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Application-level cache interface with silent degradation.
 * Errors are logged and swallowed - never propagated to callers.
 */
export interface SilentCachePort<T = unknown> {
  /** Get value or undefined (never throws/returns error) */
  get(key: string): Promise<T | undefined>;

  /** Set value (failures are logged and ignored) */
  set(key: string, value: T, options?: CacheSetOptions): Promise<void>;

  /** Delete key, returns true if existed */
  delete(key: string): Promise<boolean>;

  /** Check existence */
  has(key: string): Promise<boolean>;

  /** Clear by prefix, returns count (0 on error) */
  clearByPrefix(prefix: string): Promise<number>;

  /** Clear all entries */
  clear(): Promise<void>;

  /** Get statistics */
  stats(): Promise<CacheStats>;
}
