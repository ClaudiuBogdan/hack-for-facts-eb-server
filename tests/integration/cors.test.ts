/**
 * Integration tests for CORS plugin
 */

import { describe, expect, it, afterEach } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo } from '../fixtures/fakes.js';

import type { FastifyInstance } from 'fastify';

describe('CORS Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('Development Mode', () => {
    it('allows all origins in development', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: true,
              isProduction: false,
              isTest: true,
              port: 3000,
              host: '0.0.0.0',
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('allows requests without origin header', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: true,
              isProduction: false,
              isTest: true,
              port: 3000,
              host: '0.0.0.0',
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);
    });

    it('allows any random origin in development', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: true,
              isProduction: false,
              isTest: true,
              port: 3000,
              host: '0.0.0.0',
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://totally-random-origin.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        'https://totally-random-origin.com'
      );
    });
  });

  describe('Production Mode - ALLOWED_ORIGINS', () => {
    it('allows origins from ALLOWED_ORIGINS', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: 'https://app.example.com,https://api.example.com',
              clientBaseUrl: undefined,
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://app.example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('blocks origins not in ALLOWED_ORIGINS', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: 'https://app.example.com',
              clientBaseUrl: undefined,
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://malicious.com',
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().message).toContain('CORS origin not allowed');
    });

    it('handles multiple origins in ALLOWED_ORIGINS', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: 'https://app1.com, https://app2.com, https://app3.com',
              clientBaseUrl: undefined,
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      // Test first origin
      const response1 = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://app1.com' },
      });
      expect(response1.statusCode).toBe(200);
      expect(response1.headers['access-control-allow-origin']).toBe('https://app1.com');

      // Test second origin
      const response2 = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://app2.com' },
      });
      expect(response2.statusCode).toBe(200);
      expect(response2.headers['access-control-allow-origin']).toBe('https://app2.com');

      // Test third origin
      const response3 = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://app3.com' },
      });
      expect(response3.statusCode).toBe(200);
      expect(response3.headers['access-control-allow-origin']).toBe('https://app3.com');
    });
  });

  describe('Production Mode - CLIENT_BASE_URL', () => {
    it('allows origin from CLIENT_BASE_URL', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: undefined,
              clientBaseUrl: 'https://client.example.com',
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://client.example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://client.example.com');
    });
  });

  describe('Production Mode - PUBLIC_CLIENT_BASE_URL', () => {
    it('allows origin from PUBLIC_CLIENT_BASE_URL', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: undefined,
              clientBaseUrl: undefined,
              publicClientBaseUrl: 'https://public.example.com',
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://public.example.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://public.example.com');
    });
  });

  describe('Production Mode - Combined Origins', () => {
    it('allows origins from all config sources', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: 'https://app.example.com',
              clientBaseUrl: 'https://client.example.com',
              publicClientBaseUrl: 'https://public.example.com',
            },
          }),
        },
      });

      // Test ALLOWED_ORIGINS origin
      const response1 = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://app.example.com' },
      });
      expect(response1.statusCode).toBe(200);
      expect(response1.headers['access-control-allow-origin']).toBe('https://app.example.com');

      // Test CLIENT_BASE_URL origin
      const response2 = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://client.example.com' },
      });
      expect(response2.statusCode).toBe(200);
      expect(response2.headers['access-control-allow-origin']).toBe('https://client.example.com');

      // Test PUBLIC_CLIENT_BASE_URL origin
      const response3 = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://public.example.com' },
      });
      expect(response3.statusCode).toBe(200);
      expect(response3.headers['access-control-allow-origin']).toBe('https://public.example.com');

      // Test disallowed origin
      const response4 = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { origin: 'https://malicious.com' },
      });
      expect(response4.statusCode).toBe(500);
    });
  });

  describe('Server-to-Server Requests', () => {
    it('allows requests without origin header in production', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: 'https://app.example.com',
              clientBaseUrl: undefined,
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('CORS Headers', () => {
    it('includes correct CORS headers', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: 'https://app.example.com',
              clientBaseUrl: undefined,
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-methods']).toContain('PUT');
      expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    });

    it('exposes mcp-session-id header', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const response = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'GET',
        },
      });

      expect(response.headers['access-control-expose-headers']).toContain('mcp-session-id');
      expect(response.headers['access-control-expose-headers']).toContain('Mcp-Session-Id');
    });
  });

  describe('Edge Cases', () => {
    it('handles empty ALLOWED_ORIGINS string', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: '',
              clientBaseUrl: undefined,
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://example.com',
        },
      });

      // Should block since no origins are allowed
      expect(response.statusCode).toBe(500);
    });

    it('handles whitespace in ALLOWED_ORIGINS', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig({
            server: {
              isDevelopment: false,
              isProduction: true,
              isTest: false,
              port: 3000,
              host: '0.0.0.0',
            },
            cors: {
              allowedOrigins: '  https://app1.com  ,  https://app2.com  ',
              clientBaseUrl: undefined,
              publicClientBaseUrl: undefined,
            },
          }),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: {
          origin: 'https://app1.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://app1.com');
    });
  });
});
