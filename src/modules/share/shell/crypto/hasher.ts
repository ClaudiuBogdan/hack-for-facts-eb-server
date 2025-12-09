/**
 * Share Module - Hasher Implementation
 *
 * Shell-layer implementation of the Hasher interface using Node.js crypto.
 * Provides both SHA-256 and SHA-512 hashing for code generation.
 */

import { createHash } from 'crypto';

import type { Hasher } from '../../core/types.js';

/**
 * SHA-256 and SHA-512 hasher implementation using Node.js crypto.
 */
export const cryptoHasher: Hasher = {
  sha256(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  },

  sha512(data: string): string {
    return createHash('sha512').update(data).digest('hex');
  },
};
