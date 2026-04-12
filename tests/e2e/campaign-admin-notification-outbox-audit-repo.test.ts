import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import createPinoLogger from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import { makeCampaignNotificationOutboxAuditRepo } from '@/modules/campaign-admin-notifications/index.js';

import { dockerAvailable } from './setup.js';

import type { UserDatabase } from '@/infra/database/user/types.js';

const { Pool } = pg;

const USER_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
  'utf-8'
);

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

const listIds = (items: readonly { outboxId: string }[]): string[] =>
  items.map((item) => item.outboxId);

async function listAllPages(input: {
  repo: ReturnType<typeof makeCampaignNotificationOutboxAuditRepo>;
  sortBy: 'createdAt' | 'sentAt' | 'status' | 'attemptCount';
  sortOrder: 'asc' | 'desc';
}): Promise<string[]> {
  const ids: string[] = [];
  let cursor:
    | {
        sortBy: 'createdAt' | 'sentAt' | 'status' | 'attemptCount';
        sortOrder: 'asc' | 'desc';
        id: string;
        value: string | number | null;
      }
    | undefined;

  while (true) {
    const result = await input.repo.listCampaignNotificationAudit({
      campaignKey: 'funky',
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
      limit: 1,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return ids;
    }

    ids.push(...listIds(result.value.items));
    if (result.value.nextCursor === null) {
      break;
    }

    cursor = result.value.nextCursor;
  }

  return ids;
}

describe('campaign notification outbox audit repo', () => {
  const startedContainers: StartedPostgreSqlContainer[] = [];

  afterAll(async () => {
    await Promise.all(startedContainers.map(async (container) => container.stop()));
  });

  it('lists campaign-scoped outbox rows with filtering, sorting, cursor pagination, redaction, and safe error mapping', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();

    await withPgClient(connectionString, async (client) => {
      await client.query(USER_SCHEMA);

      await client.query(`
        INSERT INTO notificationsoutbox (
          id,
          user_id,
          to_email,
          notification_type,
          reference_id,
          scope_key,
          delivery_key,
          status,
          template_name,
          template_version,
          last_error,
          attempt_count,
          sent_at,
          metadata,
          created_at
        )
        VALUES
          (
            '11111111-1111-1111-1111-111111111111',
            'user-1',
            'user1@example.com',
            'funky:outbox:welcome',
            NULL,
            'funky:delivery:welcome',
            'funky:outbox:welcome:user-1',
            'delivered',
            'public_debate_campaign_welcome',
            '2026.04',
            NULL,
            1,
            '2026-04-10T10:02:00.000Z'::timestamptz,
            jsonb_build_object(
              'campaignKey', 'funky',
              'entityCui', '12345678',
              'entityName', 'Municipiul Exemplu',
              'acceptedTermsAt', '2026-04-10T10:00:00.000Z',
              'triggerSource', 'campaign_admin',
              'triggeredByUserId', 'admin-user'
            ),
            '2026-04-10T10:00:00.000Z'::timestamptz
          ),
          (
            '22222222-2222-2222-2222-222222222222',
            'user-2',
            'user2@example.com',
            'funky:outbox:entity_update',
            'notif-2',
            'funky:delivery:reply_received_thread-1',
            'user-2:notif-2:funky:delivery:reply_received_thread-1',
            'failed_permanent',
            'public_debate_entity_update',
            '2026.04',
            'RENDER_ERROR: template exploded',
            2,
            NULL,
            jsonb_build_object(
              'campaignKey', 'funky',
              'entityCui', '12345678',
              'entityName', 'Municipiul Exemplu',
              'threadId', 'thread-1',
              'threadKey', 'thread-key-1',
              'eventType', 'reply_received',
              'phase', 'reply_received_unreviewed',
              'institutionEmail', 'contact@primarie.ro',
              'subject', 'Sensitive subject',
              'replyTextPreview', 'Sensitive reply preview',
              'occurredAt', '2026-04-11T11:00:00.000Z'
            ),
            '2026-04-11T11:01:00.000Z'::timestamptz
          ),
          (
            '33333333-3333-3333-3333-333333333333',
            'admin:review@example.com',
            'review@example.com',
            'funky:outbox:admin_failure',
            NULL,
            'funky:delivery:admin_failure_thread-2',
            'admin:review@example.com:admin_failure:thread-2',
            'suppressed',
            'public_debate_admin_failure',
            '2026.04',
            'email.suppressed: policy',
            1,
            NULL,
            jsonb_build_object(
              'campaignKey', 'funky',
              'entityCui', '87654321',
              'entityName', 'Comuna Test',
              'threadId', 'thread-2',
              'phase', 'failed',
              'institutionEmail', 'secret@primarie.ro',
              'subject', 'Sensitive subject',
              'failureMessage', 'Sensitive provider failure'
            ),
            '2026-04-12T12:00:00.000Z'::timestamptz
          ),
          (
            '44444444-4444-4444-4444-444444444444',
            'user-4',
            'user4@example.com',
            'funky:outbox:entity_subscription',
            NULL,
            'funky:delivery:entity_subscription_87654321',
            'funky:outbox:entity_subscription:user-4:87654321',
            'suppressed',
            'public_debate_entity_subscription',
            '2026.04',
            'email.suppressed: policy',
            1,
            NULL,
            jsonb_build_object(
              'campaignKey', 'funky',
              'entityCui', '87654321',
              'entityName', 'Comuna Test',
              'acceptedTermsAt', '2026-04-12T11:55:00.000Z',
              'selectedEntities', jsonb_build_array('Comuna Test', 'Municipiul Exemplu')
            ),
            '2026-04-12T12:00:00.000Z'::timestamptz
          )
      `);
    });

    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      const repo = makeCampaignNotificationOutboxAuditRepo({
        db: userDb,
        logger: createPinoLogger({ level: 'silent' }),
      });

      const firstPage = await repo.listCampaignNotificationAudit({
        campaignKey: 'funky',
        sortBy: 'createdAt',
        sortOrder: 'desc',
        limit: 2,
      });

      expect(firstPage.isOk()).toBe(true);
      if (firstPage.isErr()) {
        return;
      }

      expect(firstPage.value.items).toHaveLength(2);
      expect(firstPage.value.hasMore).toBe(true);
      expect(firstPage.value.nextCursor).not.toBeNull();
      expect(firstPage.value.nextCursor).toEqual({
        sortBy: 'createdAt',
        sortOrder: 'desc',
        id: '33333333-3333-3333-3333-333333333333',
        value: '2026-04-12T12:00:00.000Z',
      });
      expect(firstPage.value.items[0]).toEqual(
        expect.objectContaining({
          outboxId: '44444444-4444-4444-4444-444444444444',
          notificationType: 'funky:outbox:entity_subscription',
          safeError: {
            category: 'suppressed',
            code: 'suppressed',
          },
          projection: {
            kind: 'public_debate_entity_subscription',
            entityCui: '87654321',
            entityName: 'Comuna Test',
            acceptedTermsAt: '2026-04-12T11:55:00.000Z',
            selectedEntitiesCount: 2,
          },
        })
      );
      expect(firstPage.value.items[0]).not.toHaveProperty('toEmail');
      expect(firstPage.value.items[0]).not.toHaveProperty('deliveryKey');
      const firstProjection = firstPage.value.items[0]?.projection as unknown as Record<
        string,
        unknown
      >;
      const secondProjection = firstPage.value.items[1]?.projection as unknown as Record<
        string,
        unknown
      >;
      expect(firstProjection['institutionEmail']).toBeUndefined();
      expect(secondProjection['failureMessage']).toBeUndefined();
      expect(firstPage.value.items[1]?.safeError).toEqual({
        category: 'suppressed',
        code: 'suppressed',
      });

      const secondPage = await repo.listCampaignNotificationAudit({
        campaignKey: 'funky',
        sortBy: 'createdAt',
        sortOrder: 'desc',
        limit: 2,
        ...(firstPage.value.nextCursor !== null ? { cursor: firstPage.value.nextCursor } : {}),
      });

      expect(secondPage.isOk()).toBe(true);
      if (secondPage.isOk()) {
        expect(listIds(secondPage.value.items)).toEqual([
          '22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111',
        ]);
      }

      await expect(
        listAllPages({
          repo,
          sortBy: 'createdAt',
          sortOrder: 'asc',
        })
      ).resolves.toEqual([
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
      ]);

      await expect(
        listAllPages({
          repo,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        })
      ).resolves.toEqual([
        '44444444-4444-4444-4444-444444444444',
        '33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
      ]);

      await expect(
        listAllPages({
          repo,
          sortBy: 'sentAt',
          sortOrder: 'asc',
        })
      ).resolves.toEqual([
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
      ]);

      await expect(
        listAllPages({
          repo,
          sortBy: 'sentAt',
          sortOrder: 'desc',
        })
      ).resolves.toEqual([
        '44444444-4444-4444-4444-444444444444',
        '33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
      ]);

      await expect(
        listAllPages({
          repo,
          sortBy: 'status',
          sortOrder: 'asc',
        })
      ).resolves.toEqual([
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
      ]);

      await expect(
        listAllPages({
          repo,
          sortBy: 'status',
          sortOrder: 'desc',
        })
      ).resolves.toEqual([
        '44444444-4444-4444-4444-444444444444',
        '33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
      ]);

      await expect(
        listAllPages({
          repo,
          sortBy: 'attemptCount',
          sortOrder: 'asc',
        })
      ).resolves.toEqual([
        '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
        '22222222-2222-2222-2222-222222222222',
      ]);

      await expect(
        listAllPages({
          repo,
          sortBy: 'attemptCount',
          sortOrder: 'desc',
        })
      ).resolves.toEqual([
        '22222222-2222-2222-2222-222222222222',
        '44444444-4444-4444-4444-444444444444',
        '33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
      ]);

      const filtered = await repo.listCampaignNotificationAudit({
        campaignKey: 'funky',
        sortBy: 'attemptCount',
        sortOrder: 'desc',
        limit: 10,
        eventType: 'reply_received',
        entityCui: '12345678',
      });

      expect(filtered.isOk()).toBe(true);
      if (filtered.isOk()) {
        expect(filtered.value.items).toEqual([
          expect.objectContaining({
            notificationType: 'funky:outbox:entity_update',
            projection: expect.objectContaining({
              kind: 'public_debate_entity_update',
              eventType: 'reply_received',
              threadId: 'thread-1',
            }),
          }),
        ]);
      }
    } finally {
      await userDb.destroy();
    }
  });
});
