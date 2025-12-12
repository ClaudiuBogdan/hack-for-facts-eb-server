/**
 * CORS plugin for Fastify
 * Configures Cross-Origin Resource Sharing with environment-based allowed origins
 */

import cors from '@fastify/cors';

import type { AppConfig } from '../config/env.js';
import type { FastifyInstance } from 'fastify';

/**
 * Get the set of allowed origins from configuration
 */
function getAllowedOriginsSet(config: AppConfig): Set<string> {
  const set = new Set<string>();

  // Parse comma-separated ALLOWED_ORIGINS
  if (config.cors.allowedOrigins !== undefined && config.cors.allowedOrigins !== '') {
    const raw = config.cors.allowedOrigins
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    raw.forEach((u) => set.add(u));
  }

  // Add CLIENT_BASE_URL if present
  if (config.cors.clientBaseUrl !== undefined && config.cors.clientBaseUrl !== '') {
    set.add(config.cors.clientBaseUrl.trim());
  }

  // Add PUBLIC_CLIENT_BASE_URL if present
  if (config.cors.publicClientBaseUrl !== undefined && config.cors.publicClientBaseUrl !== '') {
    set.add(config.cors.publicClientBaseUrl.trim());
  }

  return set;
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }

    // Match hostnames exactly (avoid `startsWith('http://localhost')` pitfalls)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Register CORS plugin with Fastify
 */
export async function registerCors(fastify: FastifyInstance, config: AppConfig): Promise<void> {
  const allowedOrigins = getAllowedOriginsSet(config);

  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow server-to-server or same-origin requests
      if (origin === undefined || origin === '') {
        cb(null, true);
        return;
      }

      // SECURITY: SEC-007 - Enforce CORS whitelist in all environments
      // Development mode only allows localhost origins.
      // Staging and other environments should configure ALLOWED_ORIGINS explicitly.
      if (config.server.isDevelopment) {
        // Only allow localhost variants in development
        if (isLocalhostOrigin(origin)) {
          cb(null, true);
          return;
        }
        // In development, also check allowed origins for non-localhost
        if (allowedOrigins.has(origin)) {
          cb(null, true);
          return;
        }
        cb(new Error('CORS origin not allowed in development'), false);
        return;
      }

      // In production, check against allowed origins
      if (allowedOrigins.has(origin)) {
        cb(null, true);
        return;
      }

      cb(new Error('CORS origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'x-requested-with',
      'authorization',
      'x-api-key',
      'accept',
      'mcp-session-id',
      'last-event-id',
    ],
    exposedHeaders: ['content-length', 'mcp-session-id', 'Mcp-Session-Id'],
    credentials: true,
  });
}
