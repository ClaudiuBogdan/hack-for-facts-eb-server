import { describe, expect, it, afterEach } from 'vitest';

import { createApp } from '@/app.js';

import { makeHealthChecker } from '../fixtures/builders.js';

import type { FastifyInstance } from 'fastify';

describe('GraphQL API', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('can query health', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
    });

    const query = `
      query {
        health
      }
    `;

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ health: 'ok' });
  });

  it('can query ready status', async () => {
    const dbChecker = makeHealthChecker({ name: 'database', status: 'healthy' });
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        healthCheckers: [dbChecker],
      },
    });

    const query = `
      query {
        ready {
          status
          checks {
            name
            status
          }
        }
      }
    `;

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.ready.status).toBe('ok');
    expect(body.data.ready.checks).toHaveLength(1);
    expect(body.data.ready.checks[0]).toEqual({ name: 'database', status: 'healthy' });
  });
});
