/**
 * Integration tests for Share REST API
 *
 * Tests cover:
 * - Creating short links (authenticated)
 * - Resolving short links (public)
 * - Authentication handling
 * - Domain whitelist validation
 * - Rate limiting
 * - Error responses
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  noopCache,
  type ShortLinkRepository,
  type ShortLinkCache,
} from '@/modules/share/core/ports.js';
import { makeShareRoutes } from '@/modules/share/shell/rest/routes.js';

import {
  makeFakeShortLinkRepo,
  makeFakeShortLinkCache,
  testHasher,
  createTestShortLink,
} from '../fixtures/fakes.js';

import type { ShareConfig } from '@/modules/share/core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Config
// ─────────────────────────────────────────────────────────────────────────────

const defaultTestConfig: ShareConfig = {
  allowedOrigins: ['https://transparenta.eu', 'https://www.transparenta.eu'],
  publicBaseUrl: 'https://transparenta.eu/s/',
  dailyLimit: 100,
  cacheTtlSeconds: 86400,
};

// ─────────────────────────────────────────────────────────────────────────────
// Test App Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a test Fastify app with share routes.
 */
const createTestApp = async (options: {
  shortLinkRepo?: ShortLinkRepository;
  cache?: ShortLinkCache;
  config?: ShareConfig;
}) => {
  const { provider } = createTestAuthProvider();

  const app = fastifyLib({ logger: false });

  // Add custom error handler to format all errors consistently
  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    void reply.status(statusCode).send({
      ok: false,
      error: error.code ?? error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
    });
  });

  // Add auth middleware
  app.addHook('preHandler', makeAuthMiddleware({ authProvider: provider }));

  // Register share routes
  const shortLinkRepo = options.shortLinkRepo ?? makeFakeShortLinkRepo();
  const cache = options.cache ?? noopCache;
  const config = options.config ?? defaultTestConfig;

  await app.register(
    makeShareRoutes({
      shortLinkRepo,
      cache,
      hasher: testHasher,
      config,
    })
  );

  await app.ready();
  return app;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Share REST API', () => {
  let app: FastifyInstance;
  let testAuth: ReturnType<typeof createTestAuthProvider>;

  beforeAll(() => {
    testAuth = createTestAuthProvider();
  });

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('POST /api/v1/short-links (create)', () => {
    describe('authentication', () => {
      beforeEach(async () => {
        if (app != null) await app.close();
        app = await createTestApp({});
      });

      it('returns 401 when no auth token provided', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: { 'content-type': 'application/json' },
          payload: { url: 'https://transparenta.eu/page' },
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.ok).toBe(false);
      });

      it('returns 401 when invalid auth token provided', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: 'Bearer invalid-token',
            'content-type': 'application/json',
          },
          payload: { url: 'https://transparenta.eu/page' },
        });

        expect(response.statusCode).toBe(401);
      });
    });

    describe('successful creation', () => {
      beforeEach(async () => {
        if (app != null) await app.close();
        app = await createTestApp({});
      });

      it('creates short link for valid URL', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: { url: 'https://transparenta.eu/page?foo=bar' },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.ok).toBe(true);
        expect(body.data.code).toHaveLength(16);
        expect(body.data.code).toMatch(/^[A-Za-z0-9_-]+$/);
      });

      it('returns same code for same URL from same user', async () => {
        const url = 'https://transparenta.eu/same-page';

        const response1 = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: { url },
        });

        const response2 = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: { url },
        });

        expect(response1.statusCode).toBe(200);
        expect(response2.statusCode).toBe(200);
        expect(response1.json().data.code).toBe(response2.json().data.code);
      });
    });

    describe('domain whitelist validation', () => {
      beforeEach(async () => {
        if (app != null) await app.close();
        app = await createTestApp({});
      });

      it('rejects URLs from non-whitelisted domains', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: { url: 'https://malicious.com/page' },
        });

        expect(response.statusCode).toBe(400);
        const body = response.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe('UrlNotAllowedError');
      });

      it('accepts URLs from www subdomain', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: { url: 'https://www.transparenta.eu/page' },
        });

        expect(response.statusCode).toBe(200);
      });
    });

    describe('rate limiting', () => {
      it('rejects when daily limit exceeded', async () => {
        // Create repo with many existing links for the user
        // testAuth.userIds.user1 is 'user_test_1'
        const userId = testAuth.userIds.user1;
        const now = new Date();
        const existingLinks = Array.from({ length: 100 }, (_, i) =>
          createTestShortLink({
            id: `link-${String(i)}`,
            code: `code${String(i).padStart(12, '0')}`,
            userIds: [userId],
            originalUrl: `https://transparenta.eu/page${String(i)}`,
            createdAt: now,
          })
        );

        if (app != null) await app.close();
        app = await createTestApp({
          shortLinkRepo: makeFakeShortLinkRepo({ shortLinks: existingLinks }),
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: { url: 'https://transparenta.eu/new-page' },
        });

        expect(response.statusCode).toBe(429);
        const body = response.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe('RateLimitExceededError');
      });
    });

    describe('validation', () => {
      beforeEach(async () => {
        if (app != null) await app.close();
        app = await createTestApp({});
      });

      it('rejects request without URL', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: {},
        });

        expect(response.statusCode).toBe(400);
      });

      it('rejects invalid URL format', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/short-links',
          headers: {
            authorization: `Bearer ${testAuth.tokens.user1}`,
            'content-type': 'application/json',
          },
          payload: { url: 'not-a-url' },
        });

        expect(response.statusCode).toBe(400);
      });
    });
  });

  describe('GET /api/v1/short-links/:code (resolve)', () => {
    describe('successful resolution', () => {
      it('resolves existing short link', async () => {
        const existingLink = createTestShortLink({
          code: 'ABC123DEF456GHIJ',
          originalUrl: 'https://transparenta.eu/resolved-page',
        });

        if (app != null) await app.close();
        app = await createTestApp({
          shortLinkRepo: makeFakeShortLinkRepo({ shortLinks: [existingLink] }),
        });

        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/short-links/ABC123DEF456GHIJ',
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.ok).toBe(true);
        expect(body.data.url).toBe('https://transparenta.eu/resolved-page');
      });

      it('does not require authentication', async () => {
        const existingLink = createTestShortLink({
          code: 'PUBLIC12345ABCDE',
          originalUrl: 'https://transparenta.eu/public-page',
        });

        if (app != null) await app.close();
        app = await createTestApp({
          shortLinkRepo: makeFakeShortLinkRepo({ shortLinks: [existingLink] }),
        });

        // No auth header - should still work
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/short-links/PUBLIC12345ABCDE',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().ok).toBe(true);
      });

      it('returns URL from cache when available', async () => {
        const cache = makeFakeShortLinkCache({
          entries: new Map([['CACHEDCODE12345A', 'https://transparenta.eu/cached']]),
        });

        if (app != null) await app.close();
        app = await createTestApp({
          shortLinkRepo: makeFakeShortLinkRepo(),
          cache,
        });

        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/short-links/CACHEDCODE12345A',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.url).toBe('https://transparenta.eu/cached');
      });
    });

    describe('not found', () => {
      beforeEach(async () => {
        if (app != null) await app.close();
        app = await createTestApp({});
      });

      it('returns 404 for non-existent code', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/short-links/NONEXISTENT12345',
        });

        expect(response.statusCode).toBe(404);
        const body = response.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe('ShortLinkNotFoundError');
      });
    });

    describe('validation', () => {
      beforeEach(async () => {
        if (app != null) await app.close();
        app = await createTestApp({});
      });

      it('rejects code that is too short', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/short-links/ABC',
        });

        expect(response.statusCode).toBe(400);
      });

      it('rejects code that is too long', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/short-links/ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        });

        expect(response.statusCode).toBe(400);
      });

      it('rejects code with invalid characters', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/short-links/ABC!@#$%^&*()',
        });

        expect(response.statusCode).toBe(400);
      });
    });
  });

  describe('database error handling', () => {
    it('returns 500 on database error during creation', async () => {
      if (app != null) await app.close();
      app = await createTestApp({
        shortLinkRepo: makeFakeShortLinkRepo({ simulateDbError: true }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/short-links',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: { url: 'https://transparenta.eu/page' },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe('DatabaseError');
    });

    it('returns 500 on database error during resolution', async () => {
      if (app != null) await app.close();
      app = await createTestApp({
        shortLinkRepo: makeFakeShortLinkRepo({ simulateDbError: true }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/short-links/ABC123DEF456GHIJ',
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe('DatabaseError');
    });
  });
});
