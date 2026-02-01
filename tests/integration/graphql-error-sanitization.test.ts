import { describe, expect, it, afterEach } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo, makeFakeInsDb } from '../fixtures/fakes.js';

import type { FastifyInstance } from 'fastify';

describe('GraphQL error sanitization (production)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('does not leak internal resolver errors', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: makeFakeBudgetDb(),

        insDb: makeFakeInsDb(),
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

    const query = `
      query {
        budgetSector(id: "1") {
          sector_id
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
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toBe('Internal server error');
    expect(JSON.stringify(body.errors[0])).not.toContain('DatabaseError');
    expect(body.errors[0].extensions?.exception).toBeUndefined();
  });
});
