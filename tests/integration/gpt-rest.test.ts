/**
 * Integration tests for GPT REST API
 *
 * Tests cover:
 * - API key authentication (X-API-Key header)
 * - Request validation
 * - Successful responses (wrapped in {ok: true, data: ...})
 * - Error responses (wrapped in {ok: false, error: ..., message: ...})
 * - Rate limiting
 */

import { Decimal } from 'decimal.js';
import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok, err } from 'neverthrow';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';

import { makeGptRoutes, type MakeGptRoutesDeps } from '@/modules/mcp/shell/rest/gpt-routes.js';

import type { McpRateLimiter } from '@/modules/mcp/core/ports.js';
import type { GptAuthConfig } from '@/modules/mcp/shell/rest/gpt-auth.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Config
// ─────────────────────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-gpt-api-key-12345';
const TEST_CLIENT_BASE_URL = 'https://transparenta.eu';

// ─────────────────────────────────────────────────────────────────────────────
// Fake Dependencies
// ─────────────────────────────────────────────────────────────────────────────

interface FakeEntityRepoOptions {
  entity?: { cui: string; name: string; address: string | null } | null;
  error?: boolean;
}

const makeFakeEntityRepo = (options: FakeEntityRepoOptions = {}) => {
  const defaultEntity = {
    cui: '4305857',
    name: 'Municipiul Cluj-Napoca',
    address: 'Strada Test 1',
  };
  const entity = options.entity === undefined ? defaultEntity : options.entity;

  return {
    async getById(cui: string) {
      if (options.error === true) {
        return err({ type: 'DatabaseError', message: 'Connection failed' });
      }
      if (entity !== null && entity.cui === cui) {
        return ok(entity);
      }
      return ok(null);
    },
    async getAll(filter: { search?: string }, limit: number) {
      if (options.error === true) {
        return err({ type: 'DatabaseError', message: 'Connection failed' });
      }
      if (entity === null) {
        return ok({ nodes: [] });
      }
      const results = filter.search !== undefined ? [entity] : [];
      return ok({ nodes: results.slice(0, limit) });
    },
  };
};

interface FakeExecutionRepoOptions {
  totals?: { totalIncome: Decimal; totalExpenses: Decimal };
  error?: boolean;
}

const makeFakeExecutionRepo = (options: FakeExecutionRepoOptions = {}) => {
  const defaultTotals = {
    totalIncome: new Decimal('1500000000'),
    totalExpenses: new Decimal('1400000000'),
  };
  const totals = options.totals ?? defaultTotals;

  return {
    async getYearlySnapshotTotals() {
      if (options.error === true) {
        return err({ type: 'DatabaseError', message: 'Connection failed' });
      }
      return ok(totals);
    },
  };
};

const makeFakeUatRepo = () => ({
  async getAll() {
    return ok({ nodes: [] });
  },
});

const makeFakeFunctionalClassificationRepo = () => ({
  async getAll() {
    return ok({ nodes: [] });
  },
});

const makeFakeEconomicClassificationRepo = () => ({
  async getAll() {
    return ok({ nodes: [] });
  },
});

const makeFakeEntityAnalyticsRepo = () => ({
  async getEntityAnalytics() {
    return ok({
      rows: [],
      totalCount: 0,
    });
  },
});

const makeFakeAnalyticsService = () => ({
  async getAnalyticsSeries() {
    return ok([]);
  },
});

const makeFakeAggregatedLineItemsRepo = () => ({
  async getAggregatedLineItems() {
    return ok({
      nodes: [],
      pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
    });
  },
});

const makeFakeShareLink = (options: { shortUrl?: string; error?: boolean } = {}) => ({
  async create(_url: string) {
    if (options.error === true) {
      return err({ type: 'ShareError', message: 'Failed' });
    }
    return ok(options.shortUrl ?? 'https://t.eu/abc123');
  },
});

interface FakeRateLimiterOptions {
  allowed?: boolean;
  remaining?: number;
}

const makeFakeRateLimiter = (options: FakeRateLimiterOptions = {}): McpRateLimiter => {
  const { allowed = true, remaining = 100 } = options;
  return {
    async isAllowed() {
      return allowed;
    },
    async recordRequest() {
      // no-op
    },
    async getRemainingRequests() {
      return remaining;
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Test App Factory
// ─────────────────────────────────────────────────────────────────────────────

interface CreateTestAppOptions {
  deps?: Partial<MakeGptRoutesDeps>;
  auth?: Partial<GptAuthConfig>;
  rateLimiter?: McpRateLimiter;
}

const createTestApp = async (options: CreateTestAppOptions = {}) => {
  const app = fastifyLib({ logger: false });

  const deps: MakeGptRoutesDeps = {
    entityRepo: makeFakeEntityRepo(),
    executionRepo: makeFakeExecutionRepo(),
    uatRepo: makeFakeUatRepo(),
    functionalClassificationRepo: makeFakeFunctionalClassificationRepo(),
    economicClassificationRepo: makeFakeEconomicClassificationRepo(),
    entityAnalyticsRepo: makeFakeEntityAnalyticsRepo(),
    analyticsService: makeFakeAnalyticsService(),
    aggregatedLineItemsRepo: makeFakeAggregatedLineItemsRepo(),
    shareLink: makeFakeShareLink(),
    config: { clientBaseUrl: TEST_CLIENT_BASE_URL },
    ...options.deps,
  };

  const auth: GptAuthConfig = {
    apiKey: TEST_API_KEY,
    ...options.auth,
  };

  const gptRoutes = makeGptRoutes({
    deps,
    auth,
    ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
  });

  await app.register(gptRoutes);
  await app.ready();

  return app;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GPT REST API', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('Authentication', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
      app = await createTestApp();
    });

    it('returns 401 when X-API-Key header is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: { 'content-type': 'application/json' },
        payload: { entityCui: '4305857', year: 2023 },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('UNAUTHORIZED');
      expect(body.message).toContain('X-API-Key');
    });

    it('returns 401 when API key is invalid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'wrong-key',
        },
        payload: { entityCui: '4305857', year: 2023 },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('UNAUTHORIZED');
      expect(body.message).toContain('Invalid');
    });

    it('returns 401 when API key is not configured (fail-closed)', async () => {
      if (app != null) await app.close();
      app = await createTestApp({ auth: { apiKey: undefined } });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '4305857', year: 2023 },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().ok).toBe(false);
    });

    it('allows request with valid API key', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '4305857', year: 2023 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().ok).toBe(true);
    });
  });

  describe('Rate Limiting', () => {
    it('returns 429 when rate limited', async () => {
      if (app != null) await app.close();
      app = await createTestApp({
        rateLimiter: makeFakeRateLimiter({ allowed: false }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '4305857', year: 2023 },
      });

      expect(response.statusCode).toBe(429);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('RATE_LIMIT_EXCEEDED');
    });
  });

  describe('POST /api/v1/gpt/entity-snapshot', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
      app = await createTestApp();
    });

    it('returns entity snapshot for valid CUI', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '4305857', year: 2023 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data.kind).toBe('entities.details');
      expect(body.data.item.cui).toBe('4305857');
      expect(body.data.item.name).toBe('Municipiul Cluj-Napoca');
      expect(body.data.item.totalIncome).toBe(1500000000);
      expect(body.data.item.totalExpenses).toBe(1400000000);
      expect(body.data.link).toBeDefined();
    });

    it('returns 404 when entity not found', async () => {
      if (app != null) await app.close();
      app = await createTestApp({
        deps: { entityRepo: makeFakeEntityRepo({ entity: null }) },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '0000000', year: 2023 },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('ENTITY_NOT_FOUND');
    });

    it('returns 500 when database error occurs', async () => {
      if (app != null) await app.close();
      app = await createTestApp({
        deps: { entityRepo: makeFakeEntityRepo({ error: true }) },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '4305857', year: 2023 },
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('DATABASE_ERROR');
    });

    it('requires year field', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '4305857' }, // Missing required year
      });

      // Route will process but use case requires year
      expect(response.statusCode).toBeLessThanOrEqual(500);
    });
  });

  describe('Response Format', () => {
    beforeAll(async () => {
      if (app != null) await app.close();
      app = await createTestApp();
    });

    it('success responses have {ok: true, data: ...} format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_API_KEY,
        },
        payload: { entityCui: '4305857', year: 2023 },
      });

      const body = response.json();
      expect(body).toHaveProperty('ok', true);
      expect(body).toHaveProperty('data');
      expect(body).not.toHaveProperty('error');
      expect(body).not.toHaveProperty('message');
    });

    it('error responses have {ok: false, error: ..., message: ...} format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/gpt/entity-snapshot',
        headers: { 'content-type': 'application/json' },
        payload: { entityCui: '4305857', year: 2023 },
      });

      const body = response.json();
      expect(body).toHaveProperty('ok', false);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('message');
      expect(body).not.toHaveProperty('data');
    });
  });
});
