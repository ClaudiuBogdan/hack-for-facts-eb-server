/**
 * MCP (Model Context Protocol) Session Extractor
 *
 * Extracts authentication token from MCP request metadata.
 */

import { BEARER_PREFIX } from '../../core/types.js';

import type { SessionExtractor } from '../../core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// MCP Request Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP request interface (subset of what we need).
 * Adapt based on your MCP server implementation.
 */
export interface MCPRequest {
  /** Request metadata/headers */
  meta?: {
    authorization?: string;
    [key: string]: unknown;
  };
  /** Session context (alternative location) */
  sessionContext?: {
    token?: string;
    [key: string]: unknown;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts bearer token from MCP request.
 *
 * MCP tokens can be in:
 * 1. meta.authorization header (standard Bearer format)
 * 2. sessionContext.token (alternative, raw token)
 *
 * @example
 * // Request with authorization in meta
 * const request = { meta: { authorization: 'Bearer eyJ...' } };
 * const token = mcpSessionExtractor.extractToken(request);
 * // token === 'eyJ...'
 *
 * // Request with token in sessionContext
 * const request = { sessionContext: { token: 'eyJ...' } };
 * const token = mcpSessionExtractor.extractToken(request);
 * // token === 'eyJ...'
 */
export const mcpSessionExtractor: SessionExtractor<MCPRequest> = {
  extractToken(request: MCPRequest): string | null {
    // Try authorization header first (standard format)
    const authHeader = request.meta?.authorization;
    if (typeof authHeader === 'string') {
      if (authHeader.startsWith(BEARER_PREFIX)) {
        const token = authHeader.slice(BEARER_PREFIX.length).trim();
        if (token !== '') {
          return token;
        }
      }
    }

    // Fallback to session context token (raw format)
    const contextToken = request.sessionContext?.token;
    if (typeof contextToken === 'string' && contextToken !== '') {
      return contextToken;
    }

    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory for creating MCP extractor.
 * Provided for DI consistency.
 */
export const makeMCPSessionExtractor = (): SessionExtractor<MCPRequest> => {
  return mcpSessionExtractor;
};
