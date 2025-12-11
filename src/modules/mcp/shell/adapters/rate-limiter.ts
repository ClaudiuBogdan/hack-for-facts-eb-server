/**
 * In-Memory Rate Limiter for MCP Endpoints
 *
 * SECURITY: SEC-004 - Rate limiting implementation
 * Uses sliding window algorithm for fair rate limiting.
 *
 * Note: For production with multiple instances, use Redis-based implementation.
 */

import type { McpRateLimiter } from '../../core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RateLimitEntry {
  timestamps: number[];
}

export interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Default: 100 requests per minute */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  maxRequests: 100,
  windowMs: 60 * 1000, // 1 minute
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an in-memory rate limiter using sliding window algorithm.
 *
 * @param config - Rate limiter configuration
 * @returns McpRateLimiter instance
 */
export function makeInMemoryRateLimiter(
  config: RateLimiterConfig = DEFAULT_RATE_LIMIT_CONFIG
): McpRateLimiter {
  const store = new Map<string, RateLimitEntry>();
  const { maxRequests, windowMs } = config;

  // Cleanup old entries periodically to prevent memory leaks
  const cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [key, entry] of store.entries()) {
        // Remove timestamps outside the window
        entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
        // Remove empty entries
        if (entry.timestamps.length === 0) {
          store.delete(key);
        }
      }
    },
    windowMs // Run cleanup every window period
  );

  // Allow cleanup interval to not keep process alive
  cleanupInterval.unref();

  return {
    isAllowed(key: string): Promise<boolean> {
      const now = Date.now();
      const entry = store.get(key);

      if (entry === undefined) {
        return Promise.resolve(true);
      }

      // Filter to only timestamps within window
      const recentTimestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
      entry.timestamps = recentTimestamps;

      return Promise.resolve(recentTimestamps.length < maxRequests);
    },

    recordRequest(key: string): Promise<void> {
      const now = Date.now();
      let entry = store.get(key);

      if (entry === undefined) {
        entry = { timestamps: [] };
        store.set(key, entry);
      }

      entry.timestamps.push(now);
      return Promise.resolve();
    },

    getRemainingRequests(key: string): Promise<number> {
      const now = Date.now();
      const entry = store.get(key);

      if (entry === undefined) {
        return Promise.resolve(maxRequests);
      }

      const recentCount = entry.timestamps.filter((ts) => now - ts < windowMs).length;
      return Promise.resolve(Math.max(0, maxRequests - recentCount));
    },
  };
}
