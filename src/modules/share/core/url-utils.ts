/**
 * Share Module - URL Utilities
 *
 * Pure functions for URL normalization and code generation.
 * These functions have no side effects and are fully testable.
 */

import { CODE_LENGTH, type Hasher, type UrlMetadata } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// URL Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds canonical metadata from a URL.
 * Normalizes query parameters to ensure equivalent URLs produce the same metadata.
 *
 * Rules:
 * - Query parameter keys are sorted alphabetically
 * - Multi-value parameters are deduplicated and sorted
 * - Empty values are preserved as empty string
 *
 * @param url - Full URL to normalize
 * @returns Canonical metadata object
 */
export const buildCanonicalMetadata = (url: string): UrlMetadata => {
  const urlObject = new URL(url);

  // Get unique, sorted query param keys
  const keys = Array.from(new Set(Array.from(urlObject.searchParams.keys())));
  keys.sort();

  // Build normalized query params
  const queryParams: Record<string, string | string[]> = {};
  for (const key of keys) {
    const allValues = urlObject.searchParams.getAll(key).map(String);

    if (allValues.length <= 1) {
      queryParams[key] = allValues[0] ?? '';
    } else {
      // Multi-value params: deduplicate and sort
      const deduped = Array.from(new Set(allValues));
      deduped.sort();
      queryParams[key] = deduped;
    }
  }

  return {
    path: urlObject.pathname,
    query: queryParams,
  };
};

/**
 * Compares two URL metadata objects for logical equivalence.
 * Used for collision detection.
 *
 * @param a - First metadata
 * @param b - Second metadata
 * @returns True if metadata represents the same logical URL
 */
export const isSameMetadata = (a: UrlMetadata | null, b: UrlMetadata | null): boolean => {
  if (a === null || b === null) {
    return a === b;
  }

  // Compare paths
  if (a.path !== b.path) {
    return false;
  }

  // Compare query params
  const keysA = Object.keys(a.query).sort();
  const keysB = Object.keys(b.query).sort();

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b.query, key)) {
      return false;
    }

    const va = a.query[key];
    const vb = b.query[key];

    if (Array.isArray(va) || Array.isArray(vb)) {
      const aa = Array.isArray(va) ? va : [String(va)];
      const bb = Array.isArray(vb) ? vb : [String(vb)];

      if (aa.length !== bb.length) {
        return false;
      }

      for (let i = 0; i < aa.length; i++) {
        if (aa[i] !== bb[i]) {
          return false;
        }
      }
    } else {
      if (va !== vb) {
        return false;
      }
    }
  }

  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Code Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a deterministic short code from a normalized URL.
 *
 * Algorithm:
 * 1. SHA-512 hash of the canonical URL representation + optional salt
 * 2. SHA-256 hash of the intermediate result
 * 3. Base64URL encode and take first 16 characters
 *
 * The double-hashing provides:
 * - Strong avalanche effect (SHA-512)
 * - Additional mixing (SHA-256)
 * - URL-safe output (Base64URL)
 *
 * @param hasher - Hasher port for cryptographic operations
 * @param metadata - Canonical URL metadata
 * @param salt - Optional salt for collision resolution (not used in normal flow)
 * @returns 16-character base64url code
 */
export const generateCode = (hasher: Hasher, metadata: UrlMetadata, salt = ''): string => {
  // Create a canonical string representation of the URL
  const canonicalString = JSON.stringify({
    path: metadata.path,
    query: metadata.query,
  });

  // Step 1: SHA-512 hash of canonical URL + salt
  const intermediateHash = hasher.sha512(canonicalString + salt);

  // Step 2: SHA-256 hash of intermediate result
  const finalHashHex = hasher.sha256(intermediateHash);

  // Step 3: Convert hex to base64url and take first 16 chars
  // Convert hex string to bytes, then to base64url
  const bytes = hexToBytes(finalHashHex);
  const base64url = bytesToBase64Url(bytes);

  return base64url.substring(0, CODE_LENGTH);
};

// ─────────────────────────────────────────────────────────────────────────────
// Domain Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a URL is from an approved client domain.
 *
 * @param url - URL to check
 * @param allowedOrigins - List of approved origins (e.g., "https://transparenta.eu")
 * @returns True if URL is from an approved domain
 */
export const isApprovedUrl = (url: string, allowedOrigins: string[]): boolean => {
  try {
    const urlObj = new URL(url);
    const origin = `${urlObj.protocol}//${urlObj.host}`;

    return allowedOrigins.some((allowed) => {
      // Normalize allowed origin (remove trailing slash)
      const normalizedAllowed = allowed.replace(/\/$/, '');
      return origin === normalizedAllowed;
    });
  } catch {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a hex string to a byte array.
 */
const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
};

/**
 * Converts a byte array to a base64url string.
 * Base64URL uses: A-Z, a-z, 0-9, -, _ (no +, /, =)
 */
const bytesToBase64Url = (bytes: Uint8Array): string => {
  // Base64URL alphabet (uses - instead of +, _ instead of /)
  const base64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  let result = '';
  const len = bytes.length;

  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i] ?? 0;
    const b2 = bytes[i + 1] ?? 0;
    const b3 = bytes[i + 2] ?? 0;

    // Using charAt() to avoid undefined issues with index access
    result += base64urlAlphabet.charAt(b1 >> 2);
    result += base64urlAlphabet.charAt(((b1 & 0x03) << 4) | (b2 >> 4));

    if (i + 1 < len) {
      result += base64urlAlphabet.charAt(((b2 & 0x0f) << 2) | (b3 >> 6));
    }

    if (i + 2 < len) {
      result += base64urlAlphabet.charAt(b3 & 0x3f);
    }
  }

  return result;
};
