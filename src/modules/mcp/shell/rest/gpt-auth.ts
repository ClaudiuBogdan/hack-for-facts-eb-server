/**
 * GPT REST API Authentication
 *
 * API key authentication for Custom GPT integration.
 * Uses X-API-Key header with timing-safe comparison.
 */

import { timingSafeEqual } from 'crypto';

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for GPT API authentication.
 */
export interface GptAuthConfig {
  /** API key for GPT access. If undefined, all requests are rejected. */
  apiKey: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies API key using constant-time comparison.
 *
 * SECURITY: Uses crypto.timingSafeEqual() to prevent timing attacks that could
 * allow an attacker to deduce the API key character-by-character.
 *
 * @returns true if API key is valid, false otherwise
 */
function verifyApiKey(providedKey: string, configuredKey: string): boolean {
  const configuredBuffer = Buffer.from(configuredKey, 'utf-8');
  const providedBuffer = Buffer.from(providedKey, 'utf-8');

  // If lengths differ, still perform a comparison to maintain constant time
  // This prevents length-based timing attacks
  if (configuredBuffer.length !== providedBuffer.length) {
    // Compare against itself to maintain constant execution time
    timingSafeEqual(configuredBuffer, configuredBuffer);
    return false;
  }

  return timingSafeEqual(configuredBuffer, providedBuffer);
}

/**
 * Creates a preHandler hook for API key authentication.
 *
 * SECURITY: Fail-closed design - if no API key is configured, all requests are rejected.
 */
export function makeGptAuthHook(config: GptAuthConfig) {
  return function gptAuthHook(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    const { apiKey: configuredApiKey } = config;

    // SECURITY: If no API key configured, reject all requests (fail-closed)
    if (configuredApiKey === undefined || configuredApiKey === '') {
      request.log.warn('GPT API key not configured - rejecting request');
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'API key not configured',
      });
      return;
    }

    const providedKey = request.headers['x-api-key'];

    if (typeof providedKey !== 'string') {
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'X-API-Key header required',
      });
      return;
    }

    if (!verifyApiKey(providedKey, configuredApiKey)) {
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
      return;
    }

    done();
  };
}
