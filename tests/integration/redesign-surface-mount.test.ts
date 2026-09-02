import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '@/app/build-app.js';
import { createTestAuthProvider } from '@/modules/auth/index.js';

import { makeTestConfig } from '../fixtures/builders.js';
import {
  makeFakeBudgetDb,
  makeFakeDatasetRepo,
  makeFakeInsDb,
  makeFakeKyselyDb,
} from '../fixtures/fakes.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
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

/**
 * Global-auth interaction for the public GET prefixes (/api/v1/legal/ …).
 *
 * The predicate matrix itself is unit-pinned in
 * tests/unit/app/global-auth-bypass.test.ts; these cases pin the wiring:
 * with the legacy auth preHandler active (userDb + authProvider present),
 * an anonymous GET under a public prefix must reach the mounted redesign
 * route (anything but 401), while with the flag off the pre-flag behavior
 * is unchanged.
 */
describe('redesign surface mount — public GET prefixes vs legacy auth', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  const authedDeps = () => ({
    budgetDb: makeFakeBudgetDb(),
    insDb: makeFakeInsDb(),
    datasetRepo: makeFakeDatasetRepo(),
    userDb: makeFakeKyselyDb<UserDatabase>(),
    authProvider: createTestAuthProvider().provider,
  });

  // Bogus fast-fail endpoints: the kernel pg pool is lazy and Meili/OpenSearch
  // probing degrades, so the mount succeeds without any live service.
  const kernelConfig = {
    prodDatabaseUrl: 'postgres://test:test@127.0.0.1:1/test',
    meiliHost: '',
    meiliApiKey: '',
    opensearchUrl: '',
  };

  it('anonymous GET under /api/v1/legal/ is not blocked by legacy auth when mounted', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        ...authedDeps(),
        config: makeTestConfig({ redesignSurface: { enabled: true } }),
        redesignKernelConfig: kernelConfig,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/legal/documents/171282/render',
    });
    // The route exists and auth is bypassed; the bogus DB yields a 5xx, a
    // 404/409 would be a data answer — the invariant is only "never 401".
    expect(response.statusCode).not.toBe(401);
  });

  it('GraphQL auth context: anonymous and invalid-token POSTs stay public (never 401)', async () => {
    // The unified mount passes authProvider into the redesign surface, which
    // builds a mercurius auth context. The load-bearing invariant of that
    // wiring is that the PUBLIC surface stays public: no token and a garbage
    // token must both resolve to the anonymous context, never a rejection.
    //
    // KNOWN LIMIT (opus review 2026-08-25): this passes byte-identically with
    // the `context:` wiring deleted — { __typename } never reads ctx.auth. It
    // guards a throwing/rejecting builder, not the wiring itself. The REAL pin
    // is the first auth-consuming field (Company.administrators): its test must
    // assert valid-token → populated AND no-token → withheld, through THIS
    // unified mount (the standalone redesign server never passes authProvider).
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        ...authedDeps(),
        config: makeTestConfig({ redesignSurface: { enabled: true } }),
        redesignKernelConfig: kernelConfig,
      },
    });

    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: '{ __typename }' },
    });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ data: { __typename: 'Query' } });

    const invalidToken = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: { query: '{ __typename }' },
    });
    expect(invalidToken.statusCode).toBe(200);
    expect(invalidToken.json()).toEqual({ data: { __typename: 'Query' } });
  });

  it('anonymous POST under the prefix is never bypassed', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        ...authedDeps(),
        config: makeTestConfig({ redesignSurface: { enabled: true } }),
        redesignKernelConfig: kernelConfig,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/legal/documents/171282/render',
      payload: {},
    });
    // No POST route exists under the prefix; the request must not be treated
    // as public (404 route-not-found or 401 from auth are both acceptable —
    // never a 2xx/5xx from a handler).
    expect([401, 404]).toContain(response.statusCode);
  });

  it('flag off: requests under the prefix keep the pre-flag behavior', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: { ...authedDeps(), config: makeTestConfig() },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/legal/documents/171282/render',
    });
    // Unregistered path on the legacy surface: the global auth preHandler
    // fires only for matched routes, so this pins whatever the legacy app
    // did before the flag existed — a non-2xx refusal.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect([401, 404]).toContain(response.statusCode);
  });
});

/**
 * S1-7 interim (src/app/ins-interim-surface.ts): while the INS kernel module
 * does not exist, the legacy INS roots are served on BOTH endpoints from the
 * same resolvers. Pins that the mounted surface exposes them and that the
 * legacy surface is unchanged; the flag-off case above already pins that
 * nothing leaks when the surface is not mounted.
 */
describe('redesign surface mount — S1-7 interim INS roots', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  const INS_ROOTS = [
    'insDatasets',
    'insDataset',
    'insDatasetDimensionValues',
    'insTerritories',
    'insContexts',
    'insObservations',
    'insUatIndicators',
    'insCompare',
    'insUatDashboard',
    'insLatestDatasetValues',
  ];
  const QUERY_FIELDS = '{ __type(name: "Query") { fields { name } } }';
  const fieldNames = (body: { data: Record<string, { fields: { name: string }[] }> }) =>
    body.data['__type']?.fields.map((f) => f.name) ?? [];

  it('serves the ten legacy INS roots on /api/v1/graphql and still on /graphql', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: makeFakeBudgetDb(),
        insDb: makeFakeInsDb(),
        datasetRepo: makeFakeDatasetRepo(),
        config: makeTestConfig({ redesignSurface: { enabled: true } }),
        redesignKernelConfig: {
          prodDatabaseUrl: 'postgres://test:test@127.0.0.1:1/test',
          meiliHost: '',
          meiliApiKey: '',
          opensearchUrl: '',
        },
      },
    });

    const mounted = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: QUERY_FIELDS },
    });
    expect(mounted.statusCode).toBe(200);
    const mountedFields = fieldNames(mounted.json());
    for (const root of INS_ROOTS) expect(mountedFields).toContain(root);

    const legacy = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: QUERY_FIELDS },
    });
    expect(legacy.statusCode).toBe(200);
    const legacyFields = fieldNames(legacy.json());
    for (const root of INS_ROOTS) expect(legacyFields).toContain(root);
  });
});
