/**
 * Share Module - Port Interfaces
 *
 * Defines repository and cache contracts that the shell layer must implement.
 */

import type { ShareError } from './errors.js';
import type { CreateShortLinkInput, ShortLink } from './types.js';
import type { Result } from 'neverthrow';

// Re-export Hasher for convenience
export type { Hasher } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Short Link Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for short link data access.
 */
export interface ShortLinkRepository {
  /**
   * Finds a short link by its code.
   * @returns The short link if found, null if not found
   */
  getByCode(code: string): Promise<Result<ShortLink | null, ShareError>>;

  /**
   * Finds a short link by its original URL.
   * @returns The short link if found, null if not found
   */
  getByOriginalUrl(url: string): Promise<Result<ShortLink | null, ShareError>>;

  /**
   * Creates a new short link or associates an existing one with a new user.
   * If a link with the same URL exists, adds the user to the user_ids array.
   * If a link with the same code but different URL exists, returns a collision error.
   */
  createOrAssociateUser(input: CreateShortLinkInput): Promise<Result<ShortLink, ShareError>>;

  /**
   * Counts recent short links created by a user for rate limiting.
   * @param userId - User ID to count links for
   * @param since - Count links created after this date
   */
  countRecentForUser(userId: string, since: Date): Promise<Result<number, ShareError>>;

  /**
   * Increments access statistics for a short link.
   * This is a fire-and-forget operation.
   */
  incrementAccessStats(code: string): Promise<Result<void, ShareError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Short Link Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache interface for short link resolution.
 * Used to speed up resolution of frequently accessed links.
 */
export interface ShortLinkCache {
  /**
   * Gets a cached original URL for a code.
   * @returns The original URL if cached, null if not cached
   */
  get(code: string): Promise<string | null>;

  /**
   * Caches an original URL for a code.
   * @param code - Short code
   * @param originalUrl - Original URL to cache
   */
  set(code: string, originalUrl: string): Promise<void>;
}

/**
 * No-op cache implementation for when caching is disabled.
 */
export const noopCache: ShortLinkCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
};
