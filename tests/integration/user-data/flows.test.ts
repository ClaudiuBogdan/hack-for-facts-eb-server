import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '@/app/build-app.js';
import { FUNKY_CAMPAIGN_ADMIN_PERMISSION } from '@/common/campaign-keys.js';
import { createTestAuthProvider } from '@/modules/auth/index.js';
import { ALL_USER_DATA_CATEGORIES, type CategoryDefinition } from '@/modules/user-data/index.js';

import { makeTestConfig } from '../../fixtures/builders.js';
import {
  makeFakeBudgetDb,
  makeFakeDatasetRepo,
  makeFakeInsDb,
  makeFakeKyselyDb,
} from '../../fixtures/fakes.js';
import {
  makeFakeMutationRateLimiter,
  makeFakeUserDataStore,
} from '../../fixtures/user-data/index.js';
import { makeSequentialIds, makeTestClock } from '../../support/index.js';

import type { FastifyInstance } from 'fastify';

const payload = (phase: 'idle' | 'draft' | 'pending' | 'resolved' = 'draft') => ({
  key: 'funky:interaction:one',
  interactionId: 'one',
  lessonId: 'lesson',
  kind: 'quiz',
  scope: { type: 'global' },
  completionRule: { type: 'resolved' },
  phase,
  value: null,
  result: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const mutation = (expectedRevision: number, idempotencyKey: string, phase = 'draft') => ({
  schemaVersion: 1,
  expectedRevision,
  idempotencyKey,
  payload: payload(phase as 'idle' | 'draft' | 'pending' | 'resolved'),
});

const makeHarness = async (
  options: {
    enabled?: boolean;
    categories?: readonly CategoryDefinition[];
  } = {}
) => {
  const auth = createTestAuthProvider();
  const clock = makeTestClock(new Date('2026-01-01T00:00:00.000Z'));
  const ids = makeSequentialIds('integration-user-data');
  const store = makeFakeUserDataStore({ clock, ids });
  const limiter = makeFakeMutationRateLimiter();
  const permissionCalls: { userId: string; permissionName: string }[] = [];
  const app = await createApp({
    fastifyOptions: { logger: false },
    deps: {
      budgetDb: makeFakeBudgetDb(),
      insDb: makeFakeInsDb(),
      userDb: makeFakeKyselyDb(),
      datasetRepo: makeFakeDatasetRepo(),
      authProvider: auth.provider,
      userDataStoreOverrides: {
        categories: options.categories ?? ALL_USER_DATA_CATEGORIES,
        mutationPort: store,
        readPort: store,
        adminReadPort: store,
        rateLimiter: limiter,
        ids,
        adminPermissionAuthorizer: {
          hasPermission: async (input) => {
            permissionCalls.push(input);
            return (
              input.userId === auth.userIds.user1 &&
              input.permissionName === FUNKY_CAMPAIGN_ADMIN_PERMISSION
            );
          },
        },
      },
      config: makeTestConfig({
        userDataStore: {
          enabled: options.enabled ?? true,
          reconcileMinutes: 60,
          receiptCleanupCron: '0 4 * * *',
        },
      }),
    },
  });
  return { app, auth, store, limiter, permissionCalls };
};

const headers = (auth: ReturnType<typeof createTestAuthProvider>, user: 'user1' | 'user2') => ({
  authorization: `Bearer ${auth.tokens[user]}`,
});

const recordUrl = '/api/user-data/records/funky.interaction/funky%3Ainteraction%3Aone';

describe('User Data Store v2 REST integration', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it('keeps the module fully dark when disabled and does not boot a broken registry', async () => {
    const broken = [{ ...ALL_USER_DATA_CATEGORIES[0], schemaVersions: [] }];
    const harness = await makeHarness({ enabled: false, categories: broken });
    app = harness.app;
    expect((await app.inject({ method: 'GET', url: '/api/user-data/sync' })).statusCode).toBe(404);
    expect(app.printRoutes()).not.toContain('user-data');
  });

  it('fails enabled boot on registry hash drift', async () => {
    const category = ALL_USER_DATA_CATEGORIES[0];
    const broken = [
      {
        ...category,
        schemaVersions: category.schemaVersions.map((version) => ({
          ...version,
          schemaHash: 'broken',
        })),
      },
    ];
    await expect(makeHarness({ categories: broken })).rejects.toThrow('schema hash mismatch');
  });

  it('covers owner CRUD, replay-before-limit, conflict, tombstone sync, restore, history and isolation', async () => {
    const harness = await makeHarness();
    app = harness.app;
    const owner = headers(harness.auth, 'user1');
    const other = headers(harness.auth, 'user2');

    const created = await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: owner,
      payload: mutation(0, 'create-01'),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().record.revision).toBe(1);
    expect(created.json().record.logicalKey).toBe('funky:interaction:one');
    const eventId = created.json().eventId as string;
    expect(harness.limiter.calls).toBe(1);

    harness.limiter.deny(23);
    const replay = await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: owner,
      payload: mutation(0, 'create-01'),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ eventId, replayed: true });
    expect(harness.limiter.calls).toBe(1);
    harness.limiter.allow();

    const read = await app.inject({ method: 'GET', url: recordUrl, headers: owner });
    expect(read.statusCode).toBe(200);
    expect(read.json().payload.phase).toBe('draft');
    expect((await app.inject({ method: 'GET', url: recordUrl, headers: other })).statusCode).toBe(
      404
    );

    const replaced = await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: owner,
      payload: mutation(1, 'replace-1', 'pending'),
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().record.revision).toBe(2);

    const stale = await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: owner,
      payload: mutation(1, 'replace-stale', 'resolved'),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.revision).toBe(2);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${recordUrl}?expectedRevision=2&idempotencyKey=delete-1`,
      headers: owner,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().record.status).toBe('deleted');

    const sync = await app.inject({ method: 'GET', url: '/api/user-data/sync', headers: owner });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().items).toEqual([
      expect.objectContaining({ status: 'deleted', payload: null, revision: 3 }),
    ]);

    const restored = await app.inject({
      method: 'POST',
      url: `${recordUrl}/restore`,
      headers: owner,
      payload: mutation(3, 'restore-1', 'resolved'),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().record).toMatchObject({ status: 'active', revision: 4 });

    const history = await app.inject({
      method: 'GET',
      url: `${recordUrl}/history`,
      headers: owner,
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json<{ items: { operation: string }[] }>().items.map((event) => event.operation)
    ).toEqual(['restore', 'delete', 'replace', 'create']);
    expect(
      (await app.inject({ method: 'GET', url: `${recordUrl}/history`, headers: other })).statusCode
    ).toBe(404);
  });

  it('returns 429 with Retry-After when the mutation limiter denies', async () => {
    const harness = await makeHarness();
    app = harness.app;
    harness.limiter.deny(31);
    const response = await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: headers(harness.auth, 'user1'),
      payload: mutation(0, 'limited-1'),
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('31');
  });

  it('maps a registered write-disabled schema to UPGRADE_REQUIRED', async () => {
    const categories = ALL_USER_DATA_CATEGORIES.map((category) =>
      category.category === 'funky.interaction'
        ? {
            ...category,
            schemaVersions: category.schemaVersions.map((version) => ({
              ...version,
              writeEnabled: false,
            })),
          }
        : category
    );
    const harness = await makeHarness({ categories });
    app = harness.app;
    const response = await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: headers(harness.auth, 'user1'),
      payload: mutation(0, 'upgrade-1'),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('UPGRADE_REQUIRED');
  });

  it('enforces category-specific admin isolation before authorizer probing', async () => {
    const harness = await makeHarness();
    app = harness.app;
    await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: headers(harness.auth, 'user1'),
      payload: mutation(0, 'admin-row1'),
    });
    await app.inject({
      method: 'PUT',
      url: recordUrl,
      headers: headers(harness.auth, 'user2'),
      payload: mutation(0, 'admin-row2'),
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/user-data/funky.interaction/records',
      headers: headers(harness.auth, 'user1'),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(2);
    expect(harness.permissionCalls).toEqual([
      { userId: harness.auth.userIds.user1, permissionName: 'campaign:funky_admin' },
    ]);

    const noSurface = await app.inject({
      method: 'GET',
      url: '/api/admin/user-data/learning.progress/records',
      headers: headers(harness.auth, 'user1'),
    });
    expect(noSurface.statusCode).toBe(404);
    expect(harness.permissionCalls).toHaveLength(1);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/user-data/funky.interaction/records',
      headers: headers(harness.auth, 'user2'),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(harness.permissionCalls.at(-1)).toEqual({
      userId: harness.auth.userIds.user2,
      permissionName: 'campaign:funky_admin',
    });
  });

  it('maps validation, payload size and database failures without leaking driver text', async () => {
    const tiny = ALL_USER_DATA_CATEGORIES.map((category) =>
      category.category === 'funky.interaction' ? { ...category, maxPayloadBytes: 10 } : category
    );
    const harness = await makeHarness({ categories: tiny });
    app = harness.app;
    const owner = headers(harness.auth, 'user1');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: recordUrl,
          headers: owner,
          payload: mutation(0, 'oversize1'),
        })
      ).statusCode
    ).toBe(413);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/user-data/records/unknown/key',
          headers: owner,
          payload: mutation(0, 'unknown-1'),
        })
      ).statusCode
    ).toBe(400);

    harness.store.faults.fail('findByKey', {
      error: { type: 'DatabaseError', message: 'postgres driver secret', retryable: true },
    });
    const failed = await app.inject({ method: 'GET', url: recordUrl, headers: owner });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('postgres driver secret');
  });

  it('exposes no annotation mutation surface', async () => {
    const harness = await makeHarness();
    app = harness.app;
    for (const method of ['PUT', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: `${recordUrl}/annotations/review`,
        headers: headers(harness.auth, 'user1'),
        payload: { payload: { secret: 'never accepted' } },
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
