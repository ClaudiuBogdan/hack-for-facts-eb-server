/**
 * Unit tests for share module URL utilities
 *
 * Tests cover:
 * - URL normalization (buildCanonicalMetadata)
 * - Metadata comparison (isSameMetadata)
 * - Code generation (generateCode)
 * - Domain validation (isApprovedUrl)
 */

import { describe, expect, it } from 'vitest';

import { CODE_LENGTH, type Hasher, type UrlMetadata } from '@/modules/share/core/types.js';
import {
  buildCanonicalMetadata,
  generateCode,
  isApprovedUrl,
  isSameMetadata,
} from '@/modules/share/core/url-utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Hasher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple hash function that produces different output for different inputs.
 * Uses a combination of character codes, positions, and mixing operations.
 */
const simpleHash = (data: string, length: number): string => {
  // Initialize with prime seeds
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2f;

  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    const pos = i + 1;

    // Mix character with position
    h1 = ((h1 ^ char) * 0x85ebca77 + pos) >>> 0;
    h2 = ((h2 ^ (char * pos)) * 0xc2b2ae3d) >>> 0;
    h3 = ((h3 + char) ^ (h3 << 5)) >>> 0;
    h4 = ((h4 * 31 + char + pos) ^ (h4 >>> 3)) >>> 0;
  }

  // Final mixing
  h1 = ((h1 ^ h2) * 0x85ebca77) >>> 0;
  h2 = ((h2 ^ h3) * 0xc2b2ae3d) >>> 0;
  h3 = ((h3 ^ h4) * 0x27d4eb2f) >>> 0;
  h4 = ((h4 ^ h1) * 0x9e3779b9) >>> 0;

  // Convert to hex and build result
  const parts = [
    h1.toString(16).padStart(8, '0'),
    h2.toString(16).padStart(8, '0'),
    h3.toString(16).padStart(8, '0'),
    h4.toString(16).padStart(8, '0'),
  ];

  // Repeat to get desired length
  let result = parts.join('');
  while (result.length < length) {
    // Re-hash for more data
    h1 = ((h1 ^ h4) * 0x85ebca77) >>> 0;
    h2 = ((h2 ^ h1) * 0xc2b2ae3d) >>> 0;
    h3 = ((h3 ^ h2) * 0x27d4eb2f) >>> 0;
    h4 = ((h4 ^ h3) * 0x9e3779b9) >>> 0;
    result += h1.toString(16).padStart(8, '0');
    result += h2.toString(16).padStart(8, '0');
  }

  return result.substring(0, length);
};

/**
 * Deterministic test hasher that produces predictable but unique output.
 * Uses simple mixing operations instead of real cryptography.
 */
const testHasher: Hasher = {
  sha256: (data: string): string => simpleHash(data, 64),
  sha512: (data: string): string => simpleHash(data, 128),
};

// ─────────────────────────────────────────────────────────────────────────────
// buildCanonicalMetadata tests
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCanonicalMetadata', () => {
  describe('path extraction', () => {
    it('extracts pathname from URL', () => {
      const metadata = buildCanonicalMetadata('https://example.com/path/to/page');
      expect(metadata.path).toBe('/path/to/page');
    });

    it('returns root path for domain-only URL', () => {
      const metadata = buildCanonicalMetadata('https://example.com');
      expect(metadata.path).toBe('/');
    });

    it('preserves URL-encoded characters in path', () => {
      const metadata = buildCanonicalMetadata('https://example.com/path%20with%20spaces');
      expect(metadata.path).toBe('/path%20with%20spaces');
    });
  });

  describe('query parameter normalization', () => {
    it('returns empty query object for URL without query params', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page');
      expect(metadata.query).toEqual({});
    });

    it('extracts single query parameter', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?foo=bar');
      expect(metadata.query).toEqual({ foo: 'bar' });
    });

    it('extracts multiple query parameters', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?foo=bar&baz=qux');
      expect(metadata.query).toEqual({ foo: 'bar', baz: 'qux' });
    });

    it('sorts query parameters alphabetically by key', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?z=1&a=2&m=3');
      const keys = Object.keys(metadata.query);
      expect(keys).toEqual(['a', 'm', 'z']);
    });

    it('preserves empty value as empty string', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?empty=');
      expect(metadata.query).toEqual({ empty: '' });
    });

    it('handles URL-encoded values', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?q=hello%20world');
      expect(metadata.query).toEqual({ q: 'hello world' });
    });
  });

  describe('multi-value parameters', () => {
    it('converts multi-value params to sorted array', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?tag=b&tag=a&tag=c');
      expect(metadata.query).toEqual({ tag: ['a', 'b', 'c'] });
    });

    it('deduplicates multi-value params', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?tag=a&tag=b&tag=a');
      expect(metadata.query).toEqual({ tag: ['a', 'b'] });
    });

    it('keeps single value as string, not array', () => {
      const metadata = buildCanonicalMetadata('https://example.com/page?tag=single');
      expect(metadata.query).toEqual({ tag: 'single' });
      expect(Array.isArray(metadata.query['tag'])).toBe(false);
    });
  });

  describe('equivalent URLs produce same metadata', () => {
    it('same query params in different order produce same metadata', () => {
      const meta1 = buildCanonicalMetadata('https://example.com/page?a=1&b=2');
      const meta2 = buildCanonicalMetadata('https://example.com/page?b=2&a=1');
      expect(meta1).toEqual(meta2);
    });

    it('duplicate multi-values in different order produce same metadata', () => {
      const meta1 = buildCanonicalMetadata('https://example.com/page?tag=a&tag=b');
      const meta2 = buildCanonicalMetadata('https://example.com/page?tag=b&tag=a');
      expect(meta1).toEqual(meta2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSameMetadata tests
// ─────────────────────────────────────────────────────────────────────────────

describe('isSameMetadata', () => {
  describe('null handling', () => {
    it('returns true when both are null', () => {
      expect(isSameMetadata(null, null)).toBe(true);
    });

    it('returns false when first is null', () => {
      const meta: UrlMetadata = { path: '/page', query: {} };
      expect(isSameMetadata(null, meta)).toBe(false);
    });

    it('returns false when second is null', () => {
      const meta: UrlMetadata = { path: '/page', query: {} };
      expect(isSameMetadata(meta, null)).toBe(false);
    });
  });

  describe('path comparison', () => {
    it('returns true for same paths', () => {
      const meta1: UrlMetadata = { path: '/page', query: {} };
      const meta2: UrlMetadata = { path: '/page', query: {} };
      expect(isSameMetadata(meta1, meta2)).toBe(true);
    });

    it('returns false for different paths', () => {
      const meta1: UrlMetadata = { path: '/page1', query: {} };
      const meta2: UrlMetadata = { path: '/page2', query: {} };
      expect(isSameMetadata(meta1, meta2)).toBe(false);
    });
  });

  describe('query comparison', () => {
    it('returns true for same query params', () => {
      const meta1: UrlMetadata = { path: '/page', query: { foo: 'bar' } };
      const meta2: UrlMetadata = { path: '/page', query: { foo: 'bar' } };
      expect(isSameMetadata(meta1, meta2)).toBe(true);
    });

    it('returns false for different query values', () => {
      const meta1: UrlMetadata = { path: '/page', query: { foo: 'bar' } };
      const meta2: UrlMetadata = { path: '/page', query: { foo: 'baz' } };
      expect(isSameMetadata(meta1, meta2)).toBe(false);
    });

    it('returns false for different query keys', () => {
      const meta1: UrlMetadata = { path: '/page', query: { foo: 'bar' } };
      const meta2: UrlMetadata = { path: '/page', query: { baz: 'bar' } };
      expect(isSameMetadata(meta1, meta2)).toBe(false);
    });

    it('returns false when one has extra keys', () => {
      const meta1: UrlMetadata = { path: '/page', query: { foo: 'bar' } };
      const meta2: UrlMetadata = { path: '/page', query: { foo: 'bar', extra: 'key' } };
      expect(isSameMetadata(meta1, meta2)).toBe(false);
    });
  });

  describe('array value comparison', () => {
    it('returns true for same array values', () => {
      const meta1: UrlMetadata = { path: '/page', query: { tags: ['a', 'b'] } };
      const meta2: UrlMetadata = { path: '/page', query: { tags: ['a', 'b'] } };
      expect(isSameMetadata(meta1, meta2)).toBe(true);
    });

    it('returns false for different array values', () => {
      const meta1: UrlMetadata = { path: '/page', query: { tags: ['a', 'b'] } };
      const meta2: UrlMetadata = { path: '/page', query: { tags: ['a', 'c'] } };
      expect(isSameMetadata(meta1, meta2)).toBe(false);
    });

    it('returns false for different array lengths', () => {
      const meta1: UrlMetadata = { path: '/page', query: { tags: ['a', 'b'] } };
      const meta2: UrlMetadata = { path: '/page', query: { tags: ['a', 'b', 'c'] } };
      expect(isSameMetadata(meta1, meta2)).toBe(false);
    });

    it('handles mixed string and array comparison', () => {
      const meta1: UrlMetadata = { path: '/page', query: { tag: 'a' } };
      const meta2: UrlMetadata = { path: '/page', query: { tag: ['a'] } };
      // When comparing string to single-element array, they should be equal
      expect(isSameMetadata(meta1, meta2)).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateCode tests
// ─────────────────────────────────────────────────────────────────────────────

describe('generateCode', () => {
  describe('output format', () => {
    it('generates code with correct length', () => {
      const metadata: UrlMetadata = { path: '/page', query: {} };
      const code = generateCode(testHasher, metadata);
      expect(code.length).toBe(CODE_LENGTH);
    });

    it('generates base64url safe characters only', () => {
      const metadata: UrlMetadata = { path: '/page', query: { complex: 'value!@#$%' } };
      const code = generateCode(testHasher, metadata);
      // Base64URL alphabet: A-Z, a-z, 0-9, -, _
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('determinism', () => {
    it('generates same code for same metadata', () => {
      const metadata: UrlMetadata = { path: '/page', query: { foo: 'bar' } };
      const code1 = generateCode(testHasher, metadata);
      const code2 = generateCode(testHasher, metadata);
      expect(code1).toBe(code2);
    });

    it('generates same code for equivalent metadata objects', () => {
      const meta1: UrlMetadata = { path: '/page', query: { a: '1', b: '2' } };
      const meta2: UrlMetadata = { path: '/page', query: { a: '1', b: '2' } };
      const code1 = generateCode(testHasher, meta1);
      const code2 = generateCode(testHasher, meta2);
      expect(code1).toBe(code2);
    });
  });

  describe('uniqueness', () => {
    it('generates different codes for different paths', () => {
      const meta1: UrlMetadata = { path: '/page1', query: {} };
      const meta2: UrlMetadata = { path: '/page2', query: {} };
      const code1 = generateCode(testHasher, meta1);
      const code2 = generateCode(testHasher, meta2);
      expect(code1).not.toBe(code2);
    });

    it('generates different codes for different query params', () => {
      const meta1: UrlMetadata = { path: '/page', query: { foo: 'bar' } };
      const meta2: UrlMetadata = { path: '/page', query: { foo: 'baz' } };
      const code1 = generateCode(testHasher, meta1);
      const code2 = generateCode(testHasher, meta2);
      expect(code1).not.toBe(code2);
    });
  });

  describe('salt support', () => {
    it('generates different code with salt', () => {
      const metadata: UrlMetadata = { path: '/page', query: {} };
      const code1 = generateCode(testHasher, metadata);
      const code2 = generateCode(testHasher, metadata, 'salt123');
      expect(code1).not.toBe(code2);
    });

    it('generates same code with same salt', () => {
      const metadata: UrlMetadata = { path: '/page', query: {} };
      const code1 = generateCode(testHasher, metadata, 'salt123');
      const code2 = generateCode(testHasher, metadata, 'salt123');
      expect(code1).toBe(code2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isApprovedUrl tests
// ─────────────────────────────────────────────────────────────────────────────

describe('isApprovedUrl', () => {
  const allowedOrigins = [
    'https://transparenta.eu',
    'https://www.transparenta.eu',
    'http://localhost:3000',
  ];

  describe('approved URLs', () => {
    it('approves URL from allowed origin', () => {
      expect(isApprovedUrl('https://transparenta.eu/page', allowedOrigins)).toBe(true);
    });

    it('approves URL with www prefix from allowed origin', () => {
      expect(isApprovedUrl('https://www.transparenta.eu/page', allowedOrigins)).toBe(true);
    });

    it('approves localhost URL', () => {
      expect(isApprovedUrl('http://localhost:3000/page', allowedOrigins)).toBe(true);
    });

    it('approves URL with query parameters', () => {
      expect(isApprovedUrl('https://transparenta.eu/page?foo=bar', allowedOrigins)).toBe(true);
    });

    it('approves URL with complex path', () => {
      expect(isApprovedUrl('https://transparenta.eu/path/to/page/123', allowedOrigins)).toBe(true);
    });
  });

  describe('rejected URLs', () => {
    it('rejects URL from non-allowed origin', () => {
      expect(isApprovedUrl('https://malicious.com/page', allowedOrigins)).toBe(false);
    });

    it('rejects URL with different protocol', () => {
      // http instead of https
      expect(isApprovedUrl('http://transparenta.eu/page', allowedOrigins)).toBe(false);
    });

    it('rejects URL with different port', () => {
      expect(isApprovedUrl('http://localhost:4000/page', allowedOrigins)).toBe(false);
    });

    it('rejects URL with subdomain not in allowed list', () => {
      expect(isApprovedUrl('https://sub.transparenta.eu/page', allowedOrigins)).toBe(false);
    });

    it('rejects URL that contains allowed domain as substring', () => {
      expect(isApprovedUrl('https://faketransparenta.eu/page', allowedOrigins)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for invalid URL', () => {
      expect(isApprovedUrl('not-a-url', allowedOrigins)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isApprovedUrl('', allowedOrigins)).toBe(false);
    });

    it('returns false for empty allowed origins', () => {
      expect(isApprovedUrl('https://transparenta.eu/page', [])).toBe(false);
    });

    it('handles allowed origin with trailing slash', () => {
      const originsWithSlash = ['https://transparenta.eu/'];
      expect(isApprovedUrl('https://transparenta.eu/page', originsWithSlash)).toBe(true);
    });
  });
});
