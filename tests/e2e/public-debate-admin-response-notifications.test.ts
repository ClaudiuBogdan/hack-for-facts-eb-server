import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import {
  enqueuePublicDebateAdminResponseNotifications,
  makeDeliveryRepo,
  makeExtendedNotificationsRepo,
  makePublicDebateEntityAudienceSummaryReader,
} from '@/modules/notification-delivery/index.js';

import { dockerAvailable } from './setup.js';

import type { UserDatabase } from '@/infra/database/user/types.js';

const { Pool } = pg;

const USER_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
  'utf-8'
);

interface StartedTestDatabase {
  connectionString: string;
  stop: () => Promise<void>;
}

async function startTestDatabase(): Promise<StartedTestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return {
    connectionString: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

async function withPgClient<T>(
  connectionString: string,
  callback: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

function createKyselyClient<T>(connectionString: string): Kysely<T> {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 1,
      }),
    }),
  });
}

async function seedNotification(
  client: pg.Client,
  input: {
    id?: string;
    userId: string;
    notificationType: string;
    entityCui?: string | null;
    isActive?: boolean;
    config?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  }
): Promise<string> {
  const notificationId = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;

  await client.query(
    `
      INSERT INTO notifications (
        id,
        user_id,
        entity_cui,
        notification_type,
        is_active,
        config,
        hash,
        created_at,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz)
    `,
    [
      notificationId,
      input.userId,
      input.entityCui ?? null,
      input.notificationType,
      input.isActive ?? true,
      input.config === undefined || input.config === null ? null : JSON.stringify(input.config),
      `${input.userId}:${input.notificationType}:${input.entityCui ?? 'global'}:${randomUUID()}`,
      createdAt,
      updatedAt,
    ]
  );

  return notificationId;
}

describe('public debate admin response notifications', () => {
  it('computes requester/subscriber raw and eligible counts against real notification rows', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await seedNotification(client, {
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        });
        await seedNotification(client, {
          userId: 'user-2',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        });
        await seedNotification(client, {
          userId: 'user-3',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        });
        await seedNotification(client, {
          userId: 'user-1',
          notificationType: 'global_unsubscribe',
          isActive: false,
          config: { channels: { email: false } },
        });
        await seedNotification(client, {
          userId: 'user-3',
          notificationType: 'funky:notification:global',
          isActive: false,
        });
      });

      const reader = makePublicDebateEntityAudienceSummaryReader({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const result = await reader.summarize([
        {
          entityCui: '12345678',
          requesterUserId: 'user-1',
        },
      ]);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect([...result.value.values()][0]).toEqual({
          requesterCount: 1,
          subscriberCount: 2,
          eligibleRequesterCount: 0,
          eligibleSubscriberCount: 1,
        });
      }
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('dedupes the same responseEventId and allows later response events with persisted outbox rows', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await seedNotification(client, {
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        });
      });

      const extendedNotificationsRepo = makeExtendedNotificationsRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const deliveryRepo = makeDeliveryRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const composeJobScheduler = {
        async enqueue() {
          return ok(undefined);
        },
      };

      const firstResult = await enqueuePublicDebateAdminResponseNotifications(
        {
          notificationsRepo: extendedNotificationsRepo,
          deliveryRepo,
          composeJobScheduler,
        },
        {
          runId: 'run-1',
          entityCui: '12345678',
          entityName: 'Municipiul Exemplu',
          threadId: 'thread-1',
          threadKey: 'thread-key-1',
          responseEventId: 'response-1',
          responseStatus: 'registration_number_received',
          responseDate: '2026-04-16T10:00:00.000Z',
          messageContent: 'Primul răspuns.',
          ownerUserId: 'user-1',
        }
      );
      const secondResult = await enqueuePublicDebateAdminResponseNotifications(
        {
          notificationsRepo: extendedNotificationsRepo,
          deliveryRepo,
          composeJobScheduler,
        },
        {
          runId: 'run-2',
          entityCui: '12345678',
          entityName: 'Municipiul Exemplu',
          threadId: 'thread-1',
          threadKey: 'thread-key-1',
          responseEventId: 'response-1',
          responseStatus: 'registration_number_received',
          responseDate: '2026-04-16T10:00:00.000Z',
          messageContent: 'Primul răspuns.',
          ownerUserId: 'user-1',
        }
      );
      const laterResult = await enqueuePublicDebateAdminResponseNotifications(
        {
          notificationsRepo: extendedNotificationsRepo,
          deliveryRepo,
          composeJobScheduler,
        },
        {
          runId: 'run-3',
          entityCui: '12345678',
          entityName: 'Municipiul Exemplu',
          threadId: 'thread-1',
          threadKey: 'thread-key-1',
          responseEventId: 'response-2',
          responseStatus: 'request_confirmed',
          responseDate: '2026-04-16T11:00:00.000Z',
          messageContent: 'Al doilea răspuns.',
          ownerUserId: 'user-1',
        }
      );

      expect(firstResult.isOk()).toBe(true);
      expect(secondResult.isOk()).toBe(true);
      expect(laterResult.isOk()).toBe(true);
      if (firstResult.isOk() && secondResult.isOk() && laterResult.isOk()) {
        expect(firstResult.value.createdOutboxIds).toHaveLength(1);
        expect(secondResult.value.reusedOutboxIds).toHaveLength(1);
        expect(laterResult.value.createdOutboxIds).toHaveLength(1);
      }

      await withPgClient(database.connectionString, async (client) => {
        const countResult = await client.query<{ total_count: string }>(
          `
            SELECT COUNT(*)::text AS total_count
            FROM notificationsoutbox
            WHERE notification_type = 'funky:outbox:admin_response'
          `
        );

        expect(countResult.rows[0]?.total_count).toBe('2');
      });
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('uses the oldest active entity-update row per user so distinct audience counts match one admin-response outbox row per recipient', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);

    try {
      let oldestRequesterNotificationId = '';
      let newerRequesterNotificationId = '';
      let subscriberNotificationId = '';

      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        oldestRequesterNotificationId = await seedNotification(client, {
          id: '11111111-1111-1111-1111-111111111111',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
          createdAt: '2026-04-16T09:00:00.000Z',
        });
        newerRequesterNotificationId = await seedNotification(client, {
          id: '22222222-2222-2222-2222-222222222222',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
          createdAt: '2026-04-16T09:05:00.000Z',
        });
        subscriberNotificationId = await seedNotification(client, {
          id: '33333333-3333-3333-3333-333333333333',
          userId: 'user-2',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
          createdAt: '2026-04-16T09:10:00.000Z',
        });
      });

      const reader = makePublicDebateEntityAudienceSummaryReader({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const summaryResult = await reader.summarize([
        {
          entityCui: '12345678',
          requesterUserId: 'user-1',
        },
      ]);

      expect(summaryResult.isOk()).toBe(true);
      if (summaryResult.isOk()) {
        expect([...summaryResult.value.values()][0]).toEqual({
          requesterCount: 1,
          subscriberCount: 1,
          eligibleRequesterCount: 1,
          eligibleSubscriberCount: 1,
        });
      }

      const extendedNotificationsRepo = makeExtendedNotificationsRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const deliveryRepo = makeDeliveryRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const composeJobScheduler = {
        async enqueue() {
          return ok(undefined);
        },
      };

      const enqueueResult = await enqueuePublicDebateAdminResponseNotifications(
        {
          notificationsRepo: extendedNotificationsRepo,
          deliveryRepo,
          composeJobScheduler,
        },
        {
          runId: 'run-duplicate-user',
          entityCui: '12345678',
          entityName: 'Municipiul Exemplu',
          threadId: 'thread-1',
          threadKey: 'thread-key-1',
          responseEventId: 'response-1',
          responseStatus: 'registration_number_received',
          responseDate: '2026-04-16T10:00:00.000Z',
          messageContent: 'Am înregistrat solicitarea.',
          ownerUserId: 'user-1',
        }
      );

      expect(enqueueResult.isOk()).toBe(true);
      if (enqueueResult.isOk()) {
        expect(enqueueResult.value.notificationIds).toEqual([
          oldestRequesterNotificationId,
          subscriberNotificationId,
        ]);
        expect(enqueueResult.value.createdOutboxIds).toHaveLength(2);
      }

      const keptRequesterOutbox = await deliveryRepo.findByDeliveryKey(
        `user-1:${oldestRequesterNotificationId}:funky:delivery:admin_response_thread-1_response-1`
      );
      const skippedRequesterOutbox = await deliveryRepo.findByDeliveryKey(
        `user-1:${newerRequesterNotificationId}:funky:delivery:admin_response_thread-1_response-1`
      );
      const subscriberOutbox = await deliveryRepo.findByDeliveryKey(
        `user-2:${subscriberNotificationId}:funky:delivery:admin_response_thread-1_response-1`
      );

      expect(keptRequesterOutbox.isOk()).toBe(true);
      if (keptRequesterOutbox.isOk()) {
        expect(keptRequesterOutbox.value?.referenceId).toBe(oldestRequesterNotificationId);
      }
      expect(skippedRequesterOutbox.isOk()).toBe(true);
      if (skippedRequesterOutbox.isOk()) {
        expect(skippedRequesterOutbox.value).toBeNull();
      }
      expect(subscriberOutbox.isOk()).toBe(true);
      if (subscriberOutbox.isOk()) {
        expect(subscriberOutbox.value?.referenceId).toBe(subscriberNotificationId);
      }

      await withPgClient(database.connectionString, async (client) => {
        const outboxCount = await client.query<{ total_count: string }>(
          `
            SELECT COUNT(*)::text AS total_count
            FROM notificationsoutbox
            WHERE notification_type = 'funky:outbox:admin_response'
          `
        );

        expect(outboxCount.rows[0]?.total_count).toBe('2');
      });
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });
});
