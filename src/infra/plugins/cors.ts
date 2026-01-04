/**
 * CORS plugin for Fastify
 * Configures Cross-Origin Resource Sharing with environment-based allowed origins
 */

import cors from '@fastify/cors';

import type { AppConfig } from '../config/env.js';
import type { FastifyInstance } from 'fastify';

interface AllowedOrigins {
  exact: Set<string>;
  patterns: RegExp[];
}

/**
 * Convert a glob pattern to regex (only supports * wildcard)
 * e.g., "https://*.example.com" → /^https:\/\/.*\.vercel\.app$/
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars (except *)
    .replace(/\*/g, '.*'); // Convert * to .*
  return new RegExp(`^${escaped}$`);
}

/**
 * Get allowed origins from configuration.
 * - Entries containing * are treated as glob patterns (e.g., https://*.example.com)
 * - All other entries are exact matches
 */
function getAllowedOrigins(config: AppConfig): AllowedOrigins {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];

  const addEntry = (entry: string) => {
    const trimmed = entry.trim();
    if (trimmed === '') return;

    if (trimmed.includes('*')) {
      patterns.push(globToRegex(trimmed));
    } else {
      exact.add(trimmed);
    }
  };

  // Parse comma-separated ALLOWED_ORIGINS
  if (config.cors.allowedOrigins !== undefined && config.cors.allowedOrigins !== '') {
    config.cors.allowedOrigins.split(',').forEach(addEntry);
  }

  // Add CLIENT_BASE_URL if present
  if (config.cors.clientBaseUrl !== undefined && config.cors.clientBaseUrl !== '') {
    exact.add(config.cors.clientBaseUrl.trim());
  }

  // Add PUBLIC_CLIENT_BASE_URL if present
  if (config.cors.publicClientBaseUrl !== undefined && config.cors.publicClientBaseUrl !== '') {
    exact.add(config.cors.publicClientBaseUrl.trim());
  }

  return { exact, patterns };
}

/**
 * Check if an origin matches allowed origins (exact or pattern)
 */
function isOriginAllowed(origin: string, allowed: AllowedOrigins): boolean {
  if (allowed.exact.has(origin)) return true;
  return allowed.patterns.some((pattern) => pattern.test(origin));
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
  const allowedOrigins = getAllowedOrigins(config);

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
        if (isOriginAllowed(origin, allowedOrigins)) {
          cb(null, true);
          return;
        }
        cb(new Error('CORS origin not allowed in development'), false);
        return;
      }

      // In production, check against allowed origins (exact or glob pattern)
      if (isOriginAllowed(origin, allowedOrigins)) {
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
