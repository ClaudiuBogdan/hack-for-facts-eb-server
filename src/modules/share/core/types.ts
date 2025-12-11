/**
 * Share Module - Domain Types
 *
 * Contains domain types, constants, and pure functions for the share module.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Hasher Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface for hashing operations.
 * This allows the core layer to remain pure (no crypto import).
 * Reused from notifications module pattern.
 */
export interface Hasher {
  /**
   * Generates a SHA-256 hash of the input string.
   * @returns Hex-encoded hash string
   */
  sha256(data: string): string;

  /**
   * Generates a SHA-512 hash of the input string.
   * @returns Hex-encoded hash string
   */
  sha512(data: string): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum URL length (Chrome compatibility) */
export const MAX_URL_LENGTH = 2_097_152; // 2MB

/** Short code length */
export const CODE_LENGTH = 16;

/** Default daily limit per user */
export const DEFAULT_DAILY_LIMIT = 100;

/** Default cache TTL in seconds (24 hours) */
export const DEFAULT_CACHE_TTL_SECONDS = 86400;

/** Code pattern regex for validation */
export const CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical URL metadata for collision detection.
 * Stores normalized query parameters for comparison.
 */
export interface UrlMetadata {
  /** URL pathname */
  readonly path: string;
  /** Sorted, deduplicated query parameters */
  readonly query: Record<string, string | string[]>;
}

/**
 * Short link domain entity.
 */
export interface ShortLink {
  /** Unique identifier */
  readonly id: string;
  /** 16-character short code */
  readonly code: string;
  /** Array of user IDs who created this link */
  readonly userIds: string[];
  /** Original full URL */
  readonly originalUrl: string;
  /** Creation timestamp */
  readonly createdAt: Date;
  /** Number of times link was resolved */
  readonly accessCount: number;
  /** Last resolution timestamp */
  readonly lastAccessAt: Date | null;
  /** Canonical URL metadata for collision detection */
  readonly metadata: UrlMetadata | null;
}

/**
 * Input for creating a short link.
 */
export interface CreateShortLinkInput {
  /** Short code (generated from normalized URL) */
  readonly code: string;
  /** User ID creating the link */
  readonly userId: string;
  /** Original URL to shorten */
  readonly originalUrl: string;
  /** Canonical metadata for collision detection */
  readonly metadata: UrlMetadata;
}

/**
 * Configuration for share module.
 */
export interface ShareConfig {
  /** Approved origins for domain whitelisting */
  readonly allowedOrigins: string[];
  /** Base URL for constructing share links */
  readonly publicBaseUrl: string;
  /** Maximum links per user per 24 hours */
  readonly dailyLimit: number;
  /** Cache TTL in seconds (0 = no caching) */
  readonly cacheTtlSeconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates if a string is a valid short code.
 */
export const isValidCode = (code: string): boolean => {
  return CODE_PATTERN.test(code);
};
