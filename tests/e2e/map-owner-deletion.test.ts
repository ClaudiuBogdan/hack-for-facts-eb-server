/**
 * The saved-map deletion boundary against a real PostgreSQL. The database is
 * either an external disposable one (`E2E_BUDGET_PG_URL`, loopback and named
 * `server_*`, since the suite runs the full bootstrap DDL into a fresh schema)
 * or, when a container runtime is reachable, a Testcontainers Postgres the
 * suite starts and stops itself (`disposable-postgres.ts`, codebase plan
 * §WP3). Without either the suite SKIPS, or fails when `TEST_E2E_REQUIRED=1`.
 * The e2e suites are not part of the dev-branch CI; this makes the suite
 * runnable on any Docker host without a hand-prepared database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import fastifyLib from 'fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import pinoLogger from 'pino';
import { Webhook } from 'svix';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  makeChronosDevTestSender,
  registerChronosDevNotificationDelivery,
} from '@/app/chronos-dev-notification-delivery.js';
import { registerUserStoreRoutes } from '@/app/user-store-routes.js';
import { acquireUserDataOwnerLock } from '@/infra/database/user/advisory-locks.js';
import { assertUserDataOwnerCanWrite } from '@/infra/database/user/owner-write-guard.js';
import { makeAdvancedMapAnalyticsRepo } from '@/modules/advanced-map-analytics/index.js';
import { makeAdvancedMapDatasetsRepo } from '@/modules/advanced-map-datasets/index.js';
import { toUserId } from '@/modules/auth/index.js';
import { makeClerkUserDeletionRoutes } from '@/modules/clerk-webhooks/index.js';
import {
  buildAnonymizedUserId,
  makeUserDataAnonymizer,
} from '@/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.js';
import { makeDeliveryRepo } from '@/modules/notification-delivery/index.js';
import { makeNotificationsRepo } from '@/modules/notifications/index.js';
import { makeUserDataMutationRepo } from '@/modules/user-data/index.js';

import { startDisposablePostgres, teardownDisposablePostgres } from './disposable-postgres.js';
import { makePlannedMutation, makeReceiptClaim } from '../fixtures/user-data/index.js';
import { makeTestClock } from '../support/index.js';

import type { UserDatabase } from '@/infra/database/user/types.js';

const schema = `map_owner_${randomUUID().replaceAll('-', '')}`;
const logger = pinoLogger({ level: 'silent' });
let db: Kysely<UserDatabase>;
let admin: pg.Client;
let container: Awaited<ReturnType<typeof startDisposablePostgres>>;
let ready = false;

/**
 * An external URL is guarded (loopback, `server_*`): the bootstrap DDL must
 * never run against anything but a disposable database. A container the suite
 * starts is disposable by construction, so only its database name is fixed.
 */
const resolveConnection = async (): Promise<string | undefined> => {
  const external = process.env['E2E_BUDGET_PG_URL'];
  if (external !== undefined && external !== '') {
    const target = new URL(external);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      !target.pathname.startsWith('/server_')
    )
      throw new Error('Map deletion tests require a loopback server_* disposable database');
    return external;
  }
  container = await startDisposablePostgres('server_e2e');
  return container?.getConnectionUri();
};

beforeAll(async () => {
  const connectionString = await resolveConnection();
  if (connectionString === undefined) {
    if (process.env['TEST_E2E_REQUIRED'] === '1') throw new Error('Disposable PostgreSQL required');
    console.warn(
      'Map deletion race tests skipped: no disposable PostgreSQL URL or container runtime'
    );
    return;
  }
  admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  // This unique, proven empty schema is the only target of the full bootstrap DDL.
  await admin.query(readFileSync('src/infra/database/user/schema.sql', 'utf8'));
  db = new Kysely<UserDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        max: 5,
        options: `-c search_path=${schema}`,
        application_name: schema,
        statement_timeout: 10000,
      }),
    }),
  });
  ready = true;
}, 120_000);

afterAll(async () => {
  await teardownDisposablePostgres(
    container,
    () => db?.destroy(),
    () => admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
    () => admin?.end()
  );
});

it('accepts only the signed Chronos test receipt, without recreating deleted data', async ({
  skip,
}) => {
  if (!ready) {
    skip();
    return;
  }
  const owner = 'chronos-dev-notification-delivery-test';
  const repo = makeDeliveryRepo({ db, logger });
  const outbox = (
    await repo.create({
      userId: owner,
      notificationType: 'transactional_welcome',
      referenceId: null,
      scopeKey: 'welcome',
      toEmail: 'delivered+test1@resend.dev',
      deliveryKey: `transactional_welcome:${owner}`,
    })
  )._unsafeUnwrap();
  await db
    .updateTable('notificationsoutbox')
    .set({ status: 'sending', attempt_count: 1 })
    .where('id', '=', outbox.id)
    .execute();
  const app = fastifyLib();
  const signingSecret = `whsec_${Buffer.from('chronos-fixture-webhook').toString('base64')}`;
  const signer = new Webhook(signingSecret);
  await registerChronosDevNotificationDelivery(app, db, { signingSecret });
  try {
    const now = new Date();
    const emailId = randomUUID();
    const receipt = (env: string, id = emailId, valid = true, messageId = randomUUID()) => {
      const payload = JSON.stringify({
        type: 'email.delivered',
        created_at: now.toISOString(),
        data: {
          email_id: id,
          from: 'dev@example.test',
          to: ['delivered+test1@resend.dev'],
          subject: 'Fixture',
          created_at: now.toISOString(),
          tags: { delivery_id: outbox.id, env, notification_type: 'transactional_welcome' },
        },
      });
      return app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/resend',
        payload,
        headers: {
          'content-type': 'application/json',
          'svix-id': messageId,
          'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
          'svix-signature': valid ? signer.sign(messageId, now, payload) : 'v1,invalid',
        },
      });
    };
    expect((await receipt('chronos_dev', emailId, false)).statusCode).toBe(401);
    expect((await receipt('development')).json()).toEqual({ status: 'ignored' });
    expect((await repo.findById(outbox.id))._unsafeUnwrap()?.status).toBe('sending');
    const messageId = randomUUID();
    const params = {
      to: 'delivered+test1@resend.dev',
      userId: owner,
      notificationType: 'transactional_welcome' as const,
      referenceId: null,
      subject: 'Fixture',
      html: '<p>Fixture</p>',
      text: 'Fixture',
      tags: [],
      idempotencyKey: outbox.id,
      unsubscribeUrl: 'https://example.test/',
      templateName: null,
      templateVersion: null,
      metadata: {},
    };
    let resolveProvider: (response: Response) => void = () => undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveProvider = resolve;
    });
    let notifyRequestStarted: () => void = () => undefined;
    const startedRequest = new Promise<void>((resolve) => {
      notifyRequestStarted = resolve;
    });
    let providerCalls = 0;
    const sender = makeChronosDevTestSender(
      db,
      outbox.id,
      { apiKey: 'fixture', from: 'dev@example.test' },
      async (_url, request) => {
        providerCalls++;
        const headers = new Headers(request?.headers);
        expect(headers.get('idempotency-key')).toBe(outbox.id);
        notifyRequestStarted();
        return pendingResponse;
      }
    );
    expect((await sender.send({ ...params, to: 'elsewhere@example.test' })).isErr()).toBe(true);
    expect(providerCalls).toBe(0);
    const sending = sender.send(params);
    await startedRequest;
    const delivered = receipt('chronos_dev', emailId, true, messageId);
    expect((await repo.findById(outbox.id))._unsafeUnwrap()?.resendEmailId).toBeNull();
    resolveProvider(Response.json({ id: emailId }));
    expect((await sending)._unsafeUnwrap()).toEqual({ emailId });
    expect((await delivered).json()).toEqual({
      status: 'processed',
    });
    expect((await repo.findById(outbox.id))._unsafeUnwrap()).toMatchObject({
      status: 'delivered',
      resendEmailId: emailId,
    });
    expect((await receipt('chronos_dev', randomUUID())).json()).toEqual({ status: 'ignored' });
    expect((await sender.send(params))._unsafeUnwrap()).toEqual({ emailId });
    expect(providerCalls).toBe(1);
    expect((await receipt('chronos_dev', emailId, true, messageId)).json()).toEqual({
      status: 'processed',
    });
    await db
      .updateTable('notificationsoutbox')
      .set({ status: 'failed_transient', resend_email_id: null })
      .where('id', '=', outbox.id)
      .execute();
    expect((await receipt('chronos_dev')).json()).toEqual({ status: 'processed' });
    expect((await repo.findById(outbox.id))._unsafeUnwrap()).toMatchObject({
      status: 'delivered',
      resendEmailId: emailId,
    });
    await markStarted(owner);
    expect((await receipt('chronos_dev')).json()).toEqual({ status: 'ignored' });
    expect((await sender.send(params)).isErr()).toBe(true);
    expect(providerCalls).toBe(1);
    expect(
      await db
        .selectFrom('resend_wh_emails')
        .select('email_id')
        .where('email_id', '=', emailId)
        .execute()
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

const mapInput = (userId: string) => ({
  mapId: randomUUID(),
  userId,
  title: 'Private fixture',
  description: null,
  visibility: 'private' as const,
  publicId: null,
});
const datasetInput = (userId: string) => ({
  id: randomUUID(),
  publicId: randomUUID(),
  userId,
  title: 'Private dataset',
  description: null,
  markdown: null,
  unit: 'RON',
  visibility: 'private' as const,
  rows: [{ sirutaCode: '54975', valueNumber: '1.23', valueJson: null }],
});
const markStarted = async (userId: string) => {
  const hash = createHash('sha256').update(userId).digest('hex');
  await sql`insert into userdataanonymizationaudit (user_id_hash, anonymized_user_id, first_svix_id, latest_svix_id, clerk_event_type, clerk_event_timestamp, summary)
    values (${hash}, ${`deleted-user:${hash}`}, 'fixture', 'fixture', 'user.deleted', 1, '{"status":"started"}'::jsonb)`.execute(
    db
  );
};
const deleteUser = (userId: string) =>
  makeUserDataAnonymizer({ db, logger }).anonymizeDeletedUser({
    userId,
    svixId: randomUUID(),
    eventType: 'user.deleted',
    eventTimestamp: Date.now(),
  });

// These call real repositories directly: stale auth caches or bypassed HTTP hooks cannot admit writes.
describe('saved map deletion transaction boundary', () => {
  it('rejects every owner mutation once deletion starts, including replay', async ({ skip }) => {
    if (!ready) {
      skip();
      return;
    }
    const maps = makeAdvancedMapAnalyticsRepo({ db, logger });
    const datasets = makeAdvancedMapDatasetsRepo({ db, logger });
    const owner = `user_${randomUUID()}`;
    const m = mapInput(owner);
    const d = datasetInput(owner);
    expect((await maps.createMap(m)).isOk()).toBe(true);
    expect((await datasets.createDataset(d)).isOk()).toBe(true);
    await markStarted(owner);
    const results = await Promise.all([
      maps.createMap(mapInput(owner)),
      maps.updateMap({ ...m, allowPublicWrite: true }),
      maps.softDeleteMap(m.mapId, owner, true),
      maps.appendSnapshot({
        mapId: m.mapId,
        userId: owner,
        snapshotId: randomUUID(),
        snapshotTitle: 'Snapshot',
        snapshotDescription: null,
        snapshotDocument: {
          title: 'Snapshot',
          description: null,
          state: {},
          savedAt: new Date().toISOString(),
        },
        nextMapTitle: 'New',
        nextMapDescription: null,
        nextVisibility: 'private',
        nextPublicId: null,
        allowPublicWrite: true,
        snapshotCap: 10,
      }),
      datasets.createDataset(datasetInput(owner)),
      datasets.updateDatasetMetadata({ ...d, datasetId: d.id, allowPublicWrite: true }),
      datasets.replaceDatasetRows({
        datasetId: d.id,
        userId: owner,
        rows: d.rows,
        allowPublicWrite: true,
      }),
      datasets.softDeleteDataset(d.id, owner, true),
    ]);
    for (const result of results)
      expect(result.isErr() && result.error.type).toBe('ForbiddenError');
    expect((await maps.createMap(mapInput(`other_${randomUUID()}`))).isOk()).toBe(true);
    const first = await deleteUser(owner);
    expect(first.isOk()).toBe(true);
    expect((await deleteUser(owner)).isOk()).toBe(true);
    expect((await maps.createMap(mapInput(owner))).isErr()).toBe(true);
    expect(
      (
        await db
          .selectFrom('advancedmapanalyticsmaps')
          .select('id')
          .where('user_id', '=', owner)
          .execute()
      ).length
    ).toBe(0);
    expect(
      (
        await db
          .selectFrom('advancedmapdatasetrows')
          .select('dataset_id')
          .where('dataset_id', '=', d.id)
          .execute()
      ).length
    ).toBe(0);
  });

  it('a writer waiting for the owner lock sees a newly committed tombstone', async ({ skip }) => {
    if (!ready) {
      skip();
      return;
    }
    const owner = `user_${randomUUID()}`;
    const gate = await db.startTransaction().setIsolationLevel('read committed').execute();
    await acquireUserDataOwnerLock(gate, owner);
    const writing = makeAdvancedMapAnalyticsRepo({ db, logger }).createMap(mapInput(owner));
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{
                n: string;
              }>`select count(*)::text n from pg_stat_activity where application_name=${schema} and wait_event='advisory'`.execute(
                db
              )
            ).rows[0]?.n,
          { timeout: 5000 }
        )
        .toBe('1');
      await markStarted(owner);
    } finally {
      await gate.commit().execute();
    }
    const result = await writing;
    expect(result.isErr() && result.error.type).toBe('ForbiddenError');
  });

  it('deletion waits for an already admitted writer and erases its committed row', async ({
    skip,
  }) => {
    if (!ready) {
      skip();
      return;
    }
    const owner = `user_${randomUUID()}`;
    const writer = await db.startTransaction().setIsolationLevel('read committed').execute();
    await assertUserDataOwnerCanWrite(writer, owner);
    await writer
      .insertInto('advancedmapanalyticsmaps')
      .values({
        id: randomUUID(),
        user_id: owner,
        title: 'Admitted before deletion',
        visibility: 'private',
      } as never)
      .execute();
    const deleting = deleteUser(owner);
    try {
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom('userdataanonymizationaudit')
                .select('user_id_hash')
                .where('user_id_hash', '=', createHash('sha256').update(owner).digest('hex'))
                .execute()
            ).length,
          { timeout: 5000 }
        )
        .toBe(1);
      await expect
        .poll(
          async () =>
            (
              await sql<{
                n: string;
              }>`select count(*)::text n from pg_stat_activity where application_name=${schema} and wait_event='advisory'`.execute(
                db
              )
            ).rows[0]?.n,
          { timeout: 5000 }
        )
        .toBe('1');
    } finally {
      await writer.commit().execute();
    }
    expect((await deleting).isOk()).toBe(true);
    expect(
      (
        await db
          .selectFrom('advancedmapanalyticsmaps')
          .select('id')
          .where('user_id', '=', owner)
          .execute()
      ).length
    ).toBe(0);
  });
});

it('the native receiver erases saved data and Funky registration after a signed event', async ({
  skip,
}) => {
  if (!ready) {
    skip();
    return;
  }
  const owner = `user_${randomUUID()}`;
  const maps = makeAdvancedMapAnalyticsRepo({ db, logger });
  const input = mapInput(owner);
  expect((await maps.createMap(input)).isOk()).toBe(true);
  const notifications = makeNotificationsRepo({ db, logger });
  const subscription = (
    await notifications.create({
      userId: owner,
      notificationType: 'newsletter_entity_monthly',
      entityCui: '123',
      config: null,
      hash: `fixture-${owner}`,
    })
  )._unsafeUnwrap();
  const userData = makeUserDataMutationRepo({ db, clock: makeTestClock(new Date()) });
  const plan = makePlannedMutation({
    operation: 'create',
    identity: { ownerId: owner, category: 'funky.interaction', logicalKey: 'fixture' },
    recordId: randomUUID(),
    eventId: randomUUID(),
    receipt: makeReceiptClaim({ requesterId: owner, idempotencyKeyHash: owner }),
  });
  expect((await userData.commit(plan)).isOk()).toBe(true);
  const signingSecret = `whsec_${Buffer.from('disposable-test-signing-key-only').toString('base64')}`;
  const signer = new Webhook(signingSecret);
  const app = fastifyLib();
  await app.register(makeClerkUserDeletionRoutes({ db, signingSecret, logger }));
  await registerUserStoreRoutes(app, {
    db,
    authProvider: {
      verifyToken: async (token) =>
        ok({ userId: toUserId(token), expiresAt: new Date(Date.now() + 60_000) }),
    },
    allowedOrigins: [],
  });
  try {
    const timestamp = new Date();
    const clientUpdatedAt = timestamp.toISOString();
    const progressUrl = '/api/v1/learning/progress';
    const authHeaders = { authorization: `Bearer ${owner}` };
    const registration = (entityCui: string) => {
      const key = `funky:progress:terms_accepted::entity:${entityCui}`;
      return {
        clientUpdatedAt,
        events: [
          {
            type: 'interactive.updated',
            eventId: randomUUID(),
            clientId: 'fixture',
            occurredAt: clientUpdatedAt,
            payload: {
              record: {
                key,
                interactionId: key,
                lessonId: 'funky:progress:state',
                kind: 'custom',
                completionRule: { type: 'resolved' },
                scope: { type: 'global' },
                phase: 'resolved',
                value: {
                  kind: 'json',
                  json: { value: { entityCui, acceptedTermsAt: clientUpdatedAt } },
                },
                result: null,
                updatedAt: clientUpdatedAt,
                submittedAt: null,
              },
            },
          },
        ],
      };
    };
    const sync = (payload: ReturnType<typeof registration>) =>
      app.inject({ method: 'PUT', url: progressUrl, headers: authHeaders, payload });
    const invalidCui = '1'.repeat(21);
    const failed = await sync(registration(invalidCui));
    expect(failed.statusCode, failed.body).toBe(500);
    expect(
      (
        await notifications.findByUserTypeAndEntity(owner, 'funky:notification:global', null)
      )._unsafeUnwrap()
    ).toBeNull();
    const progress = await app.inject({ method: 'GET', url: progressUrl, headers: authHeaders });
    expect(progress.json().data.snapshot.recordsByKey).toEqual({});

    const terms = registration('3814810');
    const recordKey = `funky:progress:terms_accepted::entity:3814810`;
    const saved = await sync(terms);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ newEventsCount: 1, failedEvents: [] });
    const duplicate = await sync(terms);
    expect(duplicate.json().data).toMatchObject({ newEventsCount: 0 });
    expect(
      (await app.inject({ method: 'GET', url: progressUrl, headers: authHeaders })).json().data
        .snapshot.recordsByKey[recordKey]
    ).toMatchObject({ value: { json: { value: { entityCui: '3814810' } } } });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: progressUrl,
          headers: { authorization: 'Bearer other-fixture' },
        })
      ).json().data.snapshot.recordsByKey
    ).toEqual({});
    const campaignSubscriptions = await db
      .selectFrom('notifications')
      .select(['entity_cui', 'is_active', 'notification_type'])
      .where('user_id', '=', owner)
      .where('notification_type', 'like', 'funky:notification:%')
      .orderBy('notification_type', 'asc')
      .execute();
    expect(campaignSubscriptions).toEqual([
      {
        entity_cui: '3814810',
        is_active: true,
        notification_type: 'funky:notification:entity_updates',
      },
      { entity_cui: null, is_active: true, notification_type: 'funky:notification:global' },
    ]);

    const id = `msg_${randomUUID()}`;
    const payload = JSON.stringify({
      data: { id: owner, deleted: true },
      object: 'event',
      type: 'user.deleted',
      timestamp: timestamp.getTime(),
      instance_id: 'ins_disposable_test',
    });
    const headers = {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': 'v1,invalid',
    };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/webhooks/clerk', payload, headers }))
        .statusCode
    ).toBe(401);
    expect((await maps.getMapForUser(input.mapId, owner)).unwrapOr(null)).not.toBeNull();
    await markStarted(owner);
    const pendingDeletion = await sync(registration('1280'));
    expect(pendingDeletion.statusCode, pendingDeletion.body).toBe(403);
    headers['svix-signature'] = signer.sign(id, timestamp, payload);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/webhooks/clerk', payload, headers }))
        .statusCode
    ).toBe(200);
    expect((await maps.getMapForUser(input.mapId, owner)).unwrapOr(null)).toBeNull();
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/webhooks/clerk', payload, headers }))
        .statusCode
    ).toBe(200);
    const recreated = await maps.createMap(mapInput(owner));
    expect(recreated.isErr() && recreated.error.type).toBe('ForbiddenError');
    expect(
      await db
        .selectFrom('user_data_records')
        .select(['owner_id', 'payload'])
        .where('record_id', '=', plan.recordId)
        .executeTakeFirstOrThrow()
    ).toMatchObject({ owner_id: buildAnonymizedUserId(owner), payload: {} });
    expect((await userData.commit(plan))._unsafeUnwrapErr()).toMatchObject({ type: 'Forbidden' });
    expect(
      (
        await notifications.updateWithManualOptIn(subscription.id, { isActive: true })
      )._unsafeUnwrapErr()
    ).toMatchObject({ type: 'NotificationForbiddenError' });
    expect((await notifications.findById(subscription.id))._unsafeUnwrap()?.isActive).toBe(false);
    const staleTerm = await sync(registration('1280'));
    expect(staleTerm.statusCode, staleTerm.body).toBe(403);
    expect(staleTerm.json()).toMatchObject({ error: 'ForbiddenError', retryable: false });
    const rows = await db
      .selectFrom('userinteractions')
      .select(['user_id', 'record', 'audit_events'])
      .where('user_id', 'in', [owner, buildAnonymizedUserId(owner)])
      .execute();
    expect(rows).toMatchObject([
      { user_id: buildAnonymizedUserId(owner), record: { value: null }, audit_events: [] },
    ]);
    expect(
      await db
        .selectFrom('notifications')
        .select(['is_active', 'user_id'])
        .where('user_id', 'in', [owner, buildAnonymizedUserId(owner)])
        .where('notification_type', 'like', 'funky:notification:%')
        .execute()
    ).toEqual([
      { user_id: buildAnonymizedUserId(owner), is_active: false },
      { user_id: buildAnonymizedUserId(owner), is_active: false },
    ]);
  } finally {
    await app.close();
  }
});
