/**
 * Create Short Link Use Case
 *
 * Creates a deterministic short link for a URL.
 * If the URL already exists, associates the user with the existing link.
 */

import { ok, err, type Result } from 'neverthrow';

import { createHashCollisionError, type ShareError } from '../errors.js';
import { buildCanonicalMetadata, generateCode, isSameMetadata } from '../url-utils.js';

import type { Hasher, ShortLinkRepository } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for create short link use case.
 */
export interface CreateShortLinkDeps {
  shortLinkRepo: ShortLinkRepository;
  hasher: Hasher;
}

/**
 * Input for create short link use case.
 */
export interface CreateShortLinkInput {
  /** User ID creating the link */
  userId: string;
  /** URL to shorten (assumed to be already validated) */
  url: string;
}

/**
 * Result of create short link use case.
 */
export interface CreateShortLinkResult {
  /** The short code */
  code: string;
  /** Whether this is a new link or existing */
  isNew: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a short link for a URL.
 *
 * Flow:
 * 1. Normalize URL and generate deterministic code
 * 2. Check if code already exists
 *    - If same URL: associate user with existing link
 *    - If same metadata: reuse existing link (query param order difference)
 *    - If different URL: collision error
 * 3. If code doesn't exist, create new link
 *
 * @param deps - Repository and hasher dependencies
 * @param input - URL and user ID
 * @returns Short code or error
 */
export const createShortLink = async (
  deps: CreateShortLinkDeps,
  input: CreateShortLinkInput
): Promise<Result<CreateShortLinkResult, ShareError>> => {
  const { shortLinkRepo, hasher } = deps;
  const { userId, url } = input;

  // Step 1: Normalize URL and generate code
  const metadata = buildCanonicalMetadata(url);
  const code = generateCode(hasher, metadata);

  // Step 2: Check if code already exists
  const existingResult = await shortLinkRepo.getByCode(code);
  if (existingResult.isErr()) {
    return err(existingResult.error);
  }

  const existing = existingResult.value;

  if (existing !== null) {
    // Code exists - check if it's the same URL
    if (existing.originalUrl === url) {
      // Exact same URL - associate user with existing link
      const updateResult = await shortLinkRepo.createOrAssociateUser({
        code,
        userId,
        originalUrl: url,
        metadata,
      });

      if (updateResult.isErr()) {
        return err(updateResult.error);
      }

      return ok({ code: updateResult.value.code, isNew: false });
    }

    // Check if metadata matches (same logical URL, different query param order)
    if (isSameMetadata(existing.metadata, metadata)) {
      // Logically the same URL - reuse existing link
      return ok({ code: existing.code, isNew: false });
    }

    // Different URL with same code - hash collision
    return err(createHashCollisionError(code));
  }

  // Step 3: Code doesn't exist - create new link
  const createResult = await shortLinkRepo.createOrAssociateUser({
    code,
    userId,
    originalUrl: url,
    metadata,
  });

  if (createResult.isErr()) {
    // Handle race condition: another process might have created the same link
    // Check if it's now a collision or if we can reuse
    const recheckResult = await shortLinkRepo.getByCode(code);
    if (recheckResult.isOk() && recheckResult.value !== null) {
      const raceLink = recheckResult.value;
      if (raceLink.originalUrl === url || isSameMetadata(raceLink.metadata, metadata)) {
        return ok({ code: raceLink.code, isNew: false });
      }
    }

    return err(createResult.error);
  }

  return ok({ code: createResult.value.code, isNew: true });
};
