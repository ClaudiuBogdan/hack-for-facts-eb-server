/**
 * Notifications Module - Hasher Implementation
 *
 * Shell-layer implementation of the Hasher interface using Node.js crypto.
 */

import { createHash } from 'crypto';

import type { Hasher } from '../../core/ports.js';

/**
 * SHA-256 hasher implementation using Node.js crypto.
 */
export const sha256Hasher: Hasher = {
  sha256(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  },
};
