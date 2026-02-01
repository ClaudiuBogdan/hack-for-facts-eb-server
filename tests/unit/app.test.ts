/**
 * Unit tests for app factory
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { buildApp, createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo, makeFakeInsDb } from '../fixtures/fakes.js';

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
  });
});
