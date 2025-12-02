/**
 * Integration tests for health endpoints
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createApp } from '@/app.js';

import {
  makeHealthChecker,
  makeSlowHealthChecker,
  makeFailingHealthChecker,
  makeTestConfig,
} from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo } from '../fixtures/fakes.js';

import type { FastifyInstance } from 'fastify';

describe('Health Endpoints', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('GET /health/live', () => {
    beforeEach(async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });
    });

    it('returns 200 with status ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('always returns ok regardless of dependencies', async () => {
      // Liveness should always succeed - it just checks if process is alive
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when no health checkers are configured', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ok');
      expect(body.checks).toEqual([]);
      expect(body.timestamp).toBeDefined();
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('returns 200 when all health checks pass', async () => {
      const dbChecker = makeHealthChecker({ name: 'database', status: 'healthy' });
      const redisChecker = makeHealthChecker({ name: 'redis', status: 'healthy' });

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          healthCheckers: [dbChecker, redisChecker],
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ok');
      expect(body.checks).toHaveLength(2);
      expect(body.checks).toContainEqual(
        expect.objectContaining({ name: 'database', status: 'healthy' })
      );
      expect(body.checks).toContainEqual(
        expect.objectContaining({ name: 'redis', status: 'healthy' })
      );
    });

    it('returns 503 when any health check fails', async () => {
      const dbChecker = makeHealthChecker({ name: 'database', status: 'healthy' });
      const redisChecker = makeHealthChecker({
        name: 'redis',
        status: 'unhealthy',
        message: 'Connection refused',
      });

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          healthCheckers: [dbChecker, redisChecker],
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.status).toBe('unhealthy');
      expect(body.checks).toContainEqual(
        expect.objectContaining({
          name: 'redis',
          status: 'unhealthy',
          message: 'Connection refused',
        })
      );
    });

    it('handles health checker exceptions gracefully', async () => {
      const dbChecker = makeHealthChecker({ name: 'database', status: 'healthy' });
      const failingChecker = makeFailingHealthChecker('Connection timeout');

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          healthCheckers: [dbChecker, failingChecker],
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.status).toBe('unhealthy');
      expect(body.checks).toContainEqual(
        expect.objectContaining({
          name: 'unknown',
          status: 'unhealthy',
          message: 'Connection timeout',
        })
      );
    });

    it('includes latency when provided by checker', async () => {
      const slowChecker = makeSlowHealthChecker(10, {
        name: 'slow-service',
        status: 'healthy',
      });

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          healthCheckers: [slowChecker],
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.checks[0]).toMatchObject({
        name: 'slow-service',
        status: 'healthy',
      });
      expect(body.checks[0].latencyMs).toBeGreaterThanOrEqual(10);
    });

    it('includes version when provided', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        version: '1.2.3',
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.version).toBe('1.2.3');
    });

    it('includes uptime in seconds', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      // Wait a bit to have measurable uptime
      await new Promise((resolve) => setTimeout(resolve, 100));

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof body.uptime).toBe('number');
    });

    it('runs all health checks in parallel', async () => {
      const startTime = Date.now();
      const slowChecker1 = makeSlowHealthChecker(50, { name: 'check1' });
      const slowChecker2 = makeSlowHealthChecker(50, { name: 'check2' });

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          healthCheckers: [slowChecker1, slowChecker2],
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      const duration = Date.now() - startTime;

      expect(response.statusCode).toBe(200);
      // If run in parallel, should take ~50ms, not ~100ms
      // Allow some buffer for app initialization
      expect(duration).toBeLessThan(150);
    });
  });
});
