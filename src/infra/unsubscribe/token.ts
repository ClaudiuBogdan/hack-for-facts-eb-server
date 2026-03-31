/**
 * HMAC-signed Unsubscribe Token
 *
 * Stateless token that encodes a user ID with an HMAC-SHA256 signature.
 * Replaces database-backed unsubscribe tokens.
 *
 * Format: base64url(userId + "." + hex(hmac_sha256(secret, userId)))
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { UnsubscribeTokenSigner } from '@/modules/notifications/core/ports.js';

export type { UnsubscribeTokenSigner } from '@/modules/notifications/core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const computeHmac = (secret: string, data: string): string =>
  createHmac('sha256', secret).update(data).digest('hex');

const toBase64Url = (input: string): string => Buffer.from(input).toString('base64url');

const fromBase64Url = (input: string): string | null => {
  try {
    return Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
};

/**
 * Creates an HMAC-based unsubscribe token signer.
 */
export const makeUnsubscribeTokenSigner = (secret: string): UnsubscribeTokenSigner => {
  if (secret.trim().length < 32) {
    throw new Error('Unsubscribe token signer requires a secret of at least 32 characters');
  }

  return {
    sign(userId: string): string {
      const hmac = computeHmac(secret, userId);
      return toBase64Url(`${userId}.${hmac}`);
    },

    verify(token: string): { userId: string } | null {
      const decoded = fromBase64Url(token);
      if (decoded === null) return null;

      const dotIndex = decoded.lastIndexOf('.');
      if (dotIndex <= 0) return null;

      const userId = decoded.slice(0, dotIndex);
      const providedHmac = decoded.slice(dotIndex + 1);

      if (userId.length === 0 || providedHmac.length === 0) return null;

      const expectedHmac = computeHmac(secret, userId);

      // Constant-time comparison to prevent timing attacks
      const providedBuf = Buffer.from(providedHmac);
      const expectedBuf = Buffer.from(expectedHmac);

      if (providedBuf.length !== expectedBuf.length) return null;
      if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

      return { userId };
    },
  };
};
