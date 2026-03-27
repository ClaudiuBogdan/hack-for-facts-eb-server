/**
 * Unit tests for app factory
 */

import { Writable } from 'node:stream';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { buildApp, createApp } from '@/app/build-app.js';
import { deserialize } from '@/infra/cache/serialization.js';
import { createTestAuthProvider } from '@/modules/auth/index.js';

import { makeTestConfig } from '../fixtures/builders.js';
import {
  makeFakeBudgetDb,
  makeFakeDatasetRepo,
  makeFakeInsDb,
  makeFakeKyselyDb,
} from '../fixtures/fakes.js';

interface LogEntry {
  msg?: string;
  req?: {
    url?: string;
  };
  res?: {
    statusCode?: number;
  };
  responseTime?: number;
  userId?: string;
}

interface LogCollector {
  entries: LogEntry[];
  stream: Writable;
}

function isLogEntry(value: unknown): value is LogEntry {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  const msg = candidate['msg'];
  if (msg !== undefined && typeof msg !== 'string') {
    return false;
  }

  const responseTime = candidate['responseTime'];
  if (responseTime !== undefined && typeof responseTime !== 'number') {
    return false;
  }

  const userId = candidate['userId'];
  if (userId !== undefined && typeof userId !== 'string') {
    return false;
  }

  const req = candidate['req'];
  if (req !== undefined) {
    if (req === null || typeof req !== 'object') {
      return false;
    }

    const reqUrl = (req as Record<string, unknown>)['url'];
    if (reqUrl !== undefined && typeof reqUrl !== 'string') {
      return false;
    }
  }

  const res = candidate['res'];
  if (res !== undefined) {
    if (res === null || typeof res !== 'object') {
      return false;
    }

    const statusCode = (res as Record<string, unknown>)['statusCode'];
    if (statusCode !== undefined && typeof statusCode !== 'number') {
      return false;
    }
  }

  return true;
}

function createLogCollector(): LogCollector {
  const entries: LogEntry[] = [];

  const stream = new Writable({
    write(
      chunk: string | Uint8Array,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ) {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const parsed = deserialize(trimmed);
        if (!parsed.ok) {
          // Ignore non-JSON lines from logger transport internals.
          continue;
        }

        if (isLogEntry(parsed.value)) {
          entries.push(parsed.value);
        }
      }

      callback();
    },
  });

  return { entries, stream };
}

function getLogsForPath(entries: LogEntry[], path: string, message: string): LogEntry[] {
  return entries.filter((entry) => entry.msg === message && entry.req?.url === path);
}

async function flushLogs(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

describe('App Factory', () => {
  describe('buildApp', () => {
    it('creates a Fastify instance', async () => {
      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      expect(app).toBeDefined();
      expect(app.server).toBeDefined();

      await app.close();
    });

    it('accepts custom logger', async () => {
      const app = await buildApp({
        fastifyOptions: { logger: { level: 'silent' } },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      expect(app).toBeDefined();
      expect(app.log.level).toBe('silent');

      await app.close();
    });

    it('registers health routes', async () => {
      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });
      await app.ready();

      // Check that health routes are registered
      const routes = app.printRoutes();
      expect(routes).toContain('live');
      expect(routes).toContain('ready');
      expect(routes).toContain('health');

      await app.close();
    });

    it('registers grouped-series advanced map analytics route when userDb is enabled', async () => {
      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      await app.ready();
      const routes = app.printRoutes();

      expect(routes).toContain('advanced-map-analytics/');
      expect(routes).toContain('grouped-series (POST)');

      await app.close();
    });

    it('registers advanced map analytics routes when userDb is enabled', async () => {
      const { provider } = createTestAuthProvider();

      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          authProvider: provider,
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      await app.ready();
      const routes = app.printRoutes();

      expect(routes).toContain('advanced-map-analytics/');
      expect(routes).toContain('maps (POST, GET, HEAD)');
      expect(routes).toContain('public/');
      expect(routes).toContain(':publicId (GET, HEAD)');

      await app.close();
    });

    it('registers resend webhook route when userDb and webhook secret are configured', async () => {
      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            email: {
              apiKey: undefined,
              webhookSecret: 'w'.repeat(32),
              fromAddress: 'noreply@test.example.com',
              previewEnabled: false,
              maxRps: 2,
              enabled: false,
            },
          }),
        },
      });

      await app.ready();
      const routes = app.printRoutes();

      expect(routes).toContain('webhooks/');
      expect(routes).toContain('resend (POST)');

      await app.close();
    });

    it('registers public institution correspondence routes when email is enabled', async () => {
      const testAuth = createTestAuthProvider();
      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          authProvider: testAuth.provider,
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            email: {
              apiKey: 're_test_key',
              webhookSecret: undefined,
              fromAddress: 'noreply@test.example.com',
              previewEnabled: false,
              maxRps: 2,
              enabled: true,
            },
          }),
        },
      });

      await app.ready();
      const routes = app.printRoutes();

      expect(routes).toContain('institution-correspondence/');
      expect(routes).toContain('public-debate/');
      expect(routes).toContain('self-send/prepare (POST)');

      await app.close();
    });

    it('does not register learning progress admin review routes when the API key is unset', async () => {
      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/learning-progress/reviews',
      });

      expect(response.statusCode).toBe(404);

      await app.close();
    });

    it('registers learning progress admin review routes and bypasses bearer auth validation', async () => {
      const testAuth = createTestAuthProvider();
      const app = await buildApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          authProvider: testAuth.provider,
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            learningProgress: {
              reviewApiKey: 'r'.repeat(32),
              reviewApiEnabled: true,
            },
          }),
        },
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/learning-progress/reviews',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'X-Learning-Progress-Review-Api-Key header required',
      });

      await app.close();
    });

    it('logs incoming and completed once for non-health routes', async () => {
      const logs = createLogCollector();

      const app = await buildApp({
        fastifyOptions: {
          logger: { level: 'info', stream: logs.stream },
          disableRequestLogging: true,
        },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      app.get('/probe', async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/probe',
      });

      await flushLogs();

      expect(response.statusCode).toBe(200);

      const incoming = getLogsForPath(logs.entries, '/probe', 'incoming request');
      const completed = getLogsForPath(logs.entries, '/probe', 'request completed');

      expect(incoming).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]?.res?.statusCode).toBe(200);
      expect(typeof completed[0]?.responseTime).toBe('number');

      await app.close();
    });

    it('does not emit custom request logs for health routes', async () => {
      const logs = createLogCollector();

      const app = await buildApp({
        fastifyOptions: {
          logger: { level: 'info', stream: logs.stream },
          disableRequestLogging: true,
        },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });

      await flushLogs();

      expect(response.statusCode).toBe(200);
      expect(getLogsForPath(logs.entries, '/health/live', 'incoming request')).toHaveLength(0);
      expect(getLogsForPath(logs.entries, '/health/live', 'request completed')).toHaveLength(0);

      await app.close();
    });

    it('includes userId in completion logs when auth context is available', async () => {
      const logs = createLogCollector();
      const testAuth = createTestAuthProvider();

      const app = await buildApp({
        fastifyOptions: {
          logger: { level: 'info', stream: logs.stream },
          disableRequestLogging: true,
        },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          authProvider: testAuth.provider,
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      app.get('/probe-auth', async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/probe-auth',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      await flushLogs();

      expect(response.statusCode).toBe(200);

      const completed = getLogsForPath(logs.entries, '/probe-auth', 'request completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.userId).toBe(testAuth.userIds.user1);

      await app.close();
    });
  });

  describe('createApp', () => {
    it('returns a ready app instance', async () => {
      const app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      // App should be ready (all plugins loaded)
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });

  describe('Error Handling', () => {
    let app: Awaited<ReturnType<typeof createApp>>;

    beforeEach(async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });
    });

    afterEach(async () => {
      if (app != null) await app.close();
    });

    it('returns 404 for unknown routes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/unknown-route',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: 'NotFoundError',
        message: expect.stringContaining('/unknown-route'),
      });
    });

    it('returns 404 with correct method in message', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/does-not-exist',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().message).toContain('POST');
    });

    it('uses a client error code for unsupported media types', async () => {
      const localApp = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          userDb: makeFakeKyselyDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: true,
              port: 3000,
              host: '0.0.0.0',
            },
          }),
        },
      });

      const response = await localApp.inject({
        method: 'POST',
        url: '/api/v1/notifications',
        headers: {
          'content-type': 'application/xml',
        },
        payload: '<notification />',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({
        ok: false,
        error: 'BadRequestError',
        message: 'Unsupported Media Type',
      });

      await localApp.close();
    });
  });
});
