/**
 * Resolve Short Link Use Case
 *
 * Resolves a short code to its original URL.
 * Uses caching for performance and updates access statistics asynchronously.
 */

import { ok, err, type Result } from 'neverthrow';

import { createShortLinkNotFoundError, type ShareError } from '../errors.js';

import type { ShortLinkCache, ShortLinkRepository } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for resolve short link use case.
 */
export interface ResolveShortLinkDeps {
  shortLinkRepo: ShortLinkRepository;
  cache: ShortLinkCache;
}

/**
 * Input for resolve short link use case.
 */
export interface ResolveShortLinkInput {
  /** Short code to resolve */
  code: string;
}

/**
 * Result of resolve short link use case.
 */
export interface ResolveShortLinkResult {
  /** Original URL */
  url: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a short code to its original URL.
 *
 * Flow:
 * 1. Check cache for URL
 * 2. If cache miss, query database
 * 3. Populate cache on cache miss
 * 4. Fire-and-forget: increment access statistics
 * 5. Return original URL
 *
 * @param deps - Repository and cache dependencies
 * @param input - Short code to resolve
 * @returns Original URL or error
 */
export const resolveShortLink = async (
  deps: ResolveShortLinkDeps,
  input: ResolveShortLinkInput
): Promise<Result<ResolveShortLinkResult, ShareError>> => {
  const { shortLinkRepo, cache } = deps;
  const { code } = input;

  // Step 1: Check cache
  const cachedUrl = await cache.get(code);
  if (cachedUrl !== null) {
    // Cache hit - fire-and-forget stats update
    incrementStats(shortLinkRepo, code);
    return ok({ url: cachedUrl });
  }

  // Step 2: Cache miss - query database
  const linkResult = await shortLinkRepo.getByCode(code);
  if (linkResult.isErr()) {
    return err(linkResult.error);
  }

  const link = linkResult.value;
  if (link === null) {
    return err(createShortLinkNotFoundError(code));
  }

  // Step 3: Populate cache (fire-and-forget)
  void cache.set(code, link.originalUrl).catch(() => {
    // Silently ignore cache write errors
  });

  // Step 4: Fire-and-forget stats update
  incrementStats(shortLinkRepo, code);

  // Step 5: Return URL
  return ok({ url: link.originalUrl });
};

/**
 * Increments access statistics for a short link.
 * This is a fire-and-forget operation that doesn't block the response.
 */
const incrementStats = (repo: ShortLinkRepository, code: string): void => {
  repo.incrementAccessStats(code).catch(() => {
    // Silently ignore stats update errors - not critical
  });
};
