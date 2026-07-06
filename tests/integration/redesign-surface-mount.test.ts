import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo, makeFakeInsDb } from '../fixtures/fakes.js';

import type { FastifyInstance } from 'fastify';

/**
 * Deploy-safety invariant for the optional redesign surface mount (build-app.ts).
 *
 * The legacy app must serve ONLY its own surface unless BOTH the feature flag
 * (`config.redesignSurface.enabled`) AND a `redesignKernelConfig` are provided.
 * Deployed legacy servers satisfy neither, so `/api/v1/graphql` must not exist and
 * the legacy `/graphql` must behave exactly as before. These tests pin that so the
 * mount can never silently leak into a deployment.
 */
describe('redesign surface mount — deploy-safety invariant', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  const baseDeps = () => ({
    budgetDb: makeFakeBudgetDb(),
    insDb: makeFakeInsDb(),
    datasetRepo: makeFakeDatasetRepo(),
  });

  it('does not register /api/v1/graphql when the flag is off (default)', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      // makeTestConfig defaults redesignSurface.enabled to false.
      deps: { ...baseDeps(), config: makeTestConfig() },
    });

    const redesign = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: '{ __typename }' },
    });
    expect(redesign.statusCode).toBe(404);

    // The legacy surface is unchanged.
    const legacy = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ health }' },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ data: { health: 'ok' } });
  });

  it('does not mount when the flag is on but no redesignKernelConfig is provided', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      // Flag on, but the kernel config (griffin-prod) is absent → the AND-gate
      // must keep the surface unmounted (and never build a kernel).
      deps: { ...baseDeps(), config: makeTestConfig({ redesignSurface: { enabled: true } }) },
    });

    const redesign = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: '{ __typename }' },
    });
    expect(redesign.statusCode).toBe(404);
  });
});
