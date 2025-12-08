/**
 * HTTP Session Extractor
 *
 * Extracts bearer token from HTTP Authorization header.
 */

import { AUTH_HEADER, BEARER_PREFIX } from '../../core/types.js';

import type { SessionExtractor } from '../../core/ports.js';
import type { FastifyRequest } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts bearer token from Fastify request.
 *
 * Looks for the Authorization header in format: "Bearer <token>"
 *
 * @example
 * // Request with header: Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
 * const token = httpSessionExtractor.extractToken(request);
 * // token === 'eyJhbGciOiJSUzI1NiIs...'
 *
 * // Request without header
 * const token = httpSessionExtractor.extractToken(request);
 * // token === null
 */
export const httpSessionExtractor: SessionExtractor<FastifyRequest> = {
  extractToken(request: FastifyRequest): string | null {
    const authHeader = request.headers[AUTH_HEADER];

    // Header must be a string
    if (typeof authHeader !== 'string') {
      return null;
    }

    // Must start with "Bearer "
    if (!authHeader.startsWith(BEARER_PREFIX)) {
      return null;
    }

    // Extract token after prefix
    const token = authHeader.slice(BEARER_PREFIX.length).trim();

    // Return null for empty tokens
    return token !== '' ? token : null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory for creating HTTP extractor.
 * Provided for DI consistency, though the singleton is usually sufficient.
 */
export const makeHttpSessionExtractor = (): SessionExtractor<FastifyRequest> => {
  return httpSessionExtractor;
};
