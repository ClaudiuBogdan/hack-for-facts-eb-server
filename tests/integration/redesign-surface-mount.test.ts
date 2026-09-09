import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '@/app/build-app.js';
import { createTestAuthProvider } from '@/modules/auth/index.js';
import { INS_LEGACY_ROOTS, INS_LEGACY_ROOTS_DROPPED } from '@/modules/ins-native/index.js';

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
 * The kernel surface mount in build-app.ts (mandatory in api.ts since slice 1,
 * 2026-09-09; `redesignKernelConfig` is only optional for unit-test compositions).
 *
 * The legacy /graphql endpoint is gone, so a composition without the kernel
 * config serves no GraphQL at all, and one with it serves /api/v1/graphql only.
 */
// Every case builds the full legacy app and (for most) dynamically imports the
// redesign module graph on top; under a parallel full-suite run that exceeds
// the 5 s default and timed out as a load flake (2026-09-09).
const APP_BUILD_TIMEOUT_MS = 30_000;

describe(
  'redesign surface mount — deploy-safety invariant',
  { timeout: APP_BUILD_TIMEOUT_MS },
  () => {
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

    it('serves no GraphQL at all when the kernel config is omitted (unit-test composition only)', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: { ...baseDeps(), config: makeTestConfig() },
      });

      const redesign = await app.inject({
        method: 'POST',
        url: '/api/v1/graphql',
        payload: { query: '{ __typename }' },
      });
      expect(redesign.statusCode).toBe(404);

      // The legacy /graphql endpoint is gone too (slice 1, 2026-09-09): with
      // the flag off this process serves no GraphQL at all.
      const legacy = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: '{ health }' },
      });
      expect(legacy.statusCode).toBe(404);
    });
  }
);

/**
 * Global-auth interaction for the public GET prefixes (/api/v1/legal/ …).
 *
 * The predicate matrix itself is unit-pinned in
 * tests/unit/app/global-auth-bypass.test.ts; these cases pin the wiring:
 * with the legacy auth preHandler active (userDb + authProvider present),
 * an anonymous GET under a public prefix must reach the mounted redesign
 * route (anything but 401).
 */
describe(
  'redesign surface mount — public GET prefixes vs legacy auth',
  { timeout: APP_BUILD_TIMEOUT_MS },
  () => {
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
          config: makeTestConfig(),
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
          config: makeTestConfig(),
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

    it('fails the boot when the enabled surface cannot mount (never legacy-only)', async () => {
      // With the flag on, a mount error used to be logged and swallowed: the
      // process came up, readiness passed, and /api/v1/graphql + /api/v1/mcp
      // were silently absent. The boot must fail instead.
      await expect(
        createApp({
          fastifyOptions: { logger: false },
          deps: {
            ...authedDeps(),
            config: makeTestConfig(),
            redesignKernelConfig: kernelConfig,
            registerRedesignContributors: () => {
              throw new Error('fixture mount failure');
            },
          },
        })
      ).rejects.toThrow('fixture mount failure');
    });

    it('anonymous POST under the prefix is never bypassed', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          ...authedDeps(),
          config: makeTestConfig(),
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
  }
);

/**
 * The INS kernel module (`ins-native`) is part of the default composition, so
 * the embedded surface serves the eight client-sent INS roots (and not the two
 * dropped ones) on /api/v1/graphql. The legacy /graphql endpoint and the S1-7
 * interim mount of the legacy INS module ended with review INS-01 (slice 1).
 */
describe('redesign surface mount — native INS roots', { timeout: APP_BUILD_TIMEOUT_MS }, () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });
  const QUERY_FIELDS = '{ __type(name: "Query") { fields { name } } }';
  const fieldNames = (body: { data: Record<string, { fields: { name: string }[] }> }) =>
    body.data['__type']?.fields.map((f) => f.name) ?? [];
  it('serves the eight native INS roots on /api/v1/graphql, not the two dropped legacy ones', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: makeFakeBudgetDb(),
        insDb: makeFakeInsDb(),
        datasetRepo: makeFakeDatasetRepo(),
        config: makeTestConfig(),
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
    for (const root of INS_LEGACY_ROOTS) expect(mountedFields).toContain(root);
    for (const root of INS_LEGACY_ROOTS_DROPPED) expect(mountedFields).not.toContain(root);
    // The legacy /graphql endpoint is gone (slice 1, 2026-09-09).
    const legacy = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: QUERY_FIELDS },
    });
    expect(legacy.statusCode).toBe(404);
  });
});
