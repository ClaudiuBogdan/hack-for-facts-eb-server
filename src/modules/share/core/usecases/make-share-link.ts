/**
 * Make Share Link Use Case
 *
 * Utility function for other modules to create shareable links.
 * Provides graceful fallback to original URL on any failure.
 */

import { createShortLink } from './create-short-link.js';

import type { Hasher, ShortLinkRepository } from '../ports.js';
import type { ShareConfig } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for make share link use case.
 */
export interface MakeShareLinkDeps {
  shortLinkRepo: ShortLinkRepository;
  hasher: Hasher;
  config: ShareConfig;
}

/**
 * Input for make share link use case.
 */
export interface MakeShareLinkInput {
  /** URL to create a share link for */
  url: string;
  /** User ID creating the link */
  userId: string;
}

/**
 * Logger interface for error logging.
 */
export interface ShareLinkLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a shareable short link with graceful fallback.
 *
 * This function is designed for use by other modules (AI service, report generator, etc.)
 * where creating a short link is a nice-to-have, not a requirement.
 *
 * Behavior:
 * - On success: Returns the full share URL (e.g., "https://transparenta.eu/share/Xk9mN2pQ4rS5tU6v")
 * - On failure: Logs the error and returns the original URL as fallback
 *
 * This function NEVER throws - it always returns a valid URL.
 *
 * @param deps - Repository, hasher, and config dependencies
 * @param input - URL and user ID
 * @param logger - Optional logger for error reporting
 * @returns Share URL or fallback to original URL
 */
export const makeShareLink = async (
  deps: MakeShareLinkDeps,
  input: MakeShareLinkInput,
  logger?: ShareLinkLogger
): Promise<string> => {
  const { shortLinkRepo, hasher, config } = deps;
  const { url, userId } = input;

  try {
    const result = await createShortLink({ shortLinkRepo, hasher }, { userId, url });

    if (result.isOk()) {
      const { code } = result.value;
      const baseUrl = config.publicBaseUrl.replace(/\/$/, '');
      return `${baseUrl}/share/${code}`;
    }

    // Non-throwing failure - log and return original
    logger?.warn('Short link creation failed', {
      error: result.error.type,
      message: result.error.message,
      url,
    });

    return url;
  } catch (error) {
    // Unexpected error - log and return original
    logger?.error('Short link creation threw unexpected error', {
      error: error instanceof Error ? error.message : String(error),
      url,
    });

    return url;
  }
};
