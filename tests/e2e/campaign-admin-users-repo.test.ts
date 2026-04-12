import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeLearningProgressRepo } from '@/modules/learning-progress/index.js';

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

describe('Learning progress repo campaign-admin users', () => {
  it('aggregates users with reviewable-only pending counts and cursor pagination', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO userinteractions (user_id, record_key, record, audit_events, updated_seq, created_at, updated_at)
          VALUES
            (
              'user-a',
              'funky:interaction:public_debate_request::entity:11111111',
              '{
                "key":"funky:interaction:public_debate_request::entity:11111111",
                "interactionId":"funky:interaction:public_debate_request",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"11111111"},
                "completionRule":{"type":"resolved"},
                "phase":"pending",
                "value":{
                  "kind":"json",
                  "json":{"value":{"submissionPath":"request_platform","submittedAt":"2026-04-10T11:00:00.000Z"}}
                },
                "result":null,
                "updatedAt":"2026-04-10T11:00:00.000Z",
                "submittedAt":"2026-04-10T11:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              1,
              '2026-04-10T11:00:00.000Z',
              '2026-04-10T11:00:00.000Z'
            ),
            (
              'user-a',
              'funky:interaction:public_debate_request::entity:22222222',
              '{
                "key":"funky:interaction:public_debate_request::entity:22222222",
                "interactionId":"funky:interaction:public_debate_request",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"22222222"},
                "completionRule":{"type":"resolved"},
                "phase":"pending",
                "value":{
                  "kind":"json",
                  "json":{"value":{"submissionPath":"send_yourself","submittedAt":"2026-04-10T12:00:00.000Z"}}
                },
                "result":null,
                "updatedAt":"2026-04-10T12:00:00.000Z",
                "submittedAt":"2026-04-10T12:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              2,
              '2026-04-10T12:00:00.000Z',
              '2026-04-10T12:00:00.000Z'
            ),
            (
              'user-a',
              'funky:interaction:city_hall_website::entity:33333333',
              '{
                "key":"funky:interaction:city_hall_website::entity:33333333",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"33333333"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{
                  "kind":"json",
                  "json":{"value":{"websiteUrl":"https://primarie-33333333.test","submittedAt":"2026-04-10T09:00:00.000Z"}}
                },
                "result":null,
                "review":{"status":"approved","reviewedAt":"2026-04-10T09:00:00.000Z"},
                "updatedAt":"2026-04-10T09:00:00.000Z",
                "submittedAt":"2026-04-10T09:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              3,
              '2026-04-10T09:00:00.000Z',
              '2026-04-10T09:00:00.000Z'
            ),
            (
              'user-b',
              'funky:interaction:city_hall_website::entity:44444444',
              '{
                "key":"funky:interaction:city_hall_website::entity:44444444",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"44444444"},
                "completionRule":{"type":"resolved"},
                "phase":"pending",
                "value":{
                  "kind":"json",
                  "json":{"value":{"websiteUrl":"https://primarie-44444444.test","submittedAt":"2026-04-10T13:00:00.000Z"}}
                },
                "result":null,
                "updatedAt":"2026-04-10T13:00:00.000Z",
                "submittedAt":"2026-04-10T13:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              4,
              '2026-04-10T13:00:00.000Z',
              '2026-04-10T13:00:00.000Z'
            ),
            (
              'user-c',
              'funky:interaction:funky_participation::entity:55555555',
              '{
                "key":"funky:interaction:funky_participation::entity:55555555",
                "interactionId":"funky:interaction:funky_participation",
                "lessonId":"civic-participate-and-act",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"55555555"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{
                  "kind":"json",
                  "json":{"value":{"debateTookPlace":"yes","submittedAt":"2026-04-10T14:00:00.000Z"}}
                },
                "result":null,
                "updatedAt":"2026-04-10T14:00:00.000Z",
                "submittedAt":"2026-04-10T14:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              5,
              '2026-04-10T14:00:00.000Z',
              '2026-04-10T14:00:00.000Z'
            )
        `);
      });

      const repo = makeLearningProgressRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });

      const firstPage = await repo.listCampaignAdminUsers({
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
          {
            interactionId: 'funky:interaction:funky_participation',
          },
        ],
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        sortBy: 'interactionCount',
        sortOrder: 'desc',
        limit: 2,
      });

      expect(firstPage.isOk()).toBe(true);
      if (firstPage.isErr()) {
        return;
      }

      expect(firstPage.value.items).toEqual([
        {
          userId: 'user-a',
          interactionCount: 3,
          pendingReviewCount: 1,
          latestUpdatedAt: '2026-04-10T12:00:00.000Z',
          latestInteractionId: 'funky:interaction:public_debate_request',
          latestEntityCui: '22222222',
        },
        {
          userId: 'user-b',
          interactionCount: 1,
          pendingReviewCount: 1,
          latestUpdatedAt: '2026-04-10T13:00:00.000Z',
          latestInteractionId: 'funky:interaction:city_hall_website',
          latestEntityCui: '44444444',
        },
      ]);
      expect(firstPage.value.hasMore).toBe(true);
      expect(firstPage.value.nextCursor).toEqual({
        sortBy: 'interactionCount',
        sortOrder: 'desc',
        userId: 'user-b',
        value: 1,
      });

      const secondPage = await repo.listCampaignAdminUsers({
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
          {
            interactionId: 'funky:interaction:funky_participation',
          },
        ],
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        sortBy: 'interactionCount',
        sortOrder: 'desc',
        limit: 2,
        ...(firstPage.value.nextCursor !== null ? { cursor: firstPage.value.nextCursor } : {}),
      });

      expect(secondPage.isOk()).toBe(true);
      if (secondPage.isErr()) {
        return;
      }

      expect(secondPage.value.items).toEqual([
        {
          userId: 'user-c',
          interactionCount: 1,
          pendingReviewCount: 0,
          latestUpdatedAt: '2026-04-10T14:00:00.000Z',
          latestInteractionId: 'funky:interaction:funky_participation',
          latestEntityCui: '55555555',
        },
      ]);
      expect(secondPage.value.hasMore).toBe(false);
      expect(secondPage.value.nextCursor).toBeNull();

      const filtered = await repo.listCampaignAdminUsers({
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
          {
            interactionId: 'funky:interaction:funky_participation',
          },
        ],
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        query: 'user-c',
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        limit: 10,
      });

      expect(filtered.isOk()).toBe(true);
      if (filtered.isErr()) {
        return;
      }

      expect(filtered.value.items).toEqual([
        {
          userId: 'user-c',
          interactionCount: 1,
          pendingReviewCount: 0,
          latestUpdatedAt: '2026-04-10T14:00:00.000Z',
          latestInteractionId: 'funky:interaction:funky_participation',
          latestEntityCui: '55555555',
        },
      ]);
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('aggregates entity-associated users from interactions and active subscriptions', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO userinteractions (user_id, record_key, record, audit_events, updated_seq, created_at, updated_at)
          VALUES
            (
              'user-alpha',
              'funky:interaction:public_debate_request::entity:11111111',
              '{
                "key":"funky:interaction:public_debate_request::entity:11111111",
                "interactionId":"funky:interaction:public_debate_request",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"11111111"},
                "completionRule":{"type":"resolved"},
                "phase":"pending",
                "value":{
                  "kind":"json",
                  "json":{"value":{"submissionPath":"request_platform","submittedAt":"2026-04-10T11:00:00.000Z"}}
                },
                "result":null,
                "updatedAt":"2026-04-10T11:00:00.000Z",
                "submittedAt":"2026-04-10T11:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              1,
              '2026-04-10T11:00:00.000Z',
              '2026-04-10T11:00:00.000Z'
            ),
            (
              'user-beta',
              'funky:interaction:public_debate_request::entity:11111111::send-yourself',
              '{
                "key":"funky:interaction:public_debate_request::entity:11111111::send-yourself",
                "interactionId":"funky:interaction:public_debate_request",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"11111111"},
                "completionRule":{"type":"resolved"},
                "phase":"pending",
                "value":{
                  "kind":"json",
                  "json":{"value":{"submissionPath":"send_yourself","submittedAt":"2026-04-10T12:00:00.000Z"}}
                },
                "result":null,
                "updatedAt":"2026-04-10T12:00:00.000Z",
                "submittedAt":"2026-04-10T12:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              2,
              '2026-04-10T12:00:00.000Z',
              '2026-04-10T12:00:00.000Z'
            ),
            (
              'user-other-entity',
              'funky:interaction:city_hall_website::entity:22222222',
              '{
                "key":"funky:interaction:city_hall_website::entity:22222222",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"22222222"},
                "completionRule":{"type":"resolved"},
                "phase":"pending",
                "value":{
                  "kind":"json",
                  "json":{"value":{"websiteUrl":"https://primarie-22222222.test","submittedAt":"2026-04-10T13:00:00.000Z"}}
                },
                "result":null,
                "updatedAt":"2026-04-10T13:00:00.000Z",
                "submittedAt":"2026-04-10T13:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              3,
              '2026-04-10T13:00:00.000Z',
              '2026-04-10T13:00:00.000Z'
            )
        `);

        await client.query(`
          INSERT INTO notifications (id, user_id, entity_cui, notification_type, is_active, config, hash, created_at, updated_at)
          VALUES
            (
              '20000000-0000-0000-0000-000000000001',
              'user-subscriber',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-global-subscriber',
              '2026-04-10T13:00:00.000Z',
              '2026-04-10T13:00:00.000Z'
            ),
            (
              '20000000-0000-0000-0000-000000000002',
              'user-subscriber',
              '11111111',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-entity-subscriber',
              '2026-04-10T14:00:00.000Z',
              '2026-04-10T14:00:00.000Z'
            ),
            (
              '20000000-0000-0000-0000-000000000003',
              'user-unsubscribed',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-global-unsubscribed',
              '2026-04-10T09:00:00.000Z',
              '2026-04-10T09:00:00.000Z'
            ),
            (
              '20000000-0000-0000-0000-000000000004',
              'user-unsubscribed',
              '11111111',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-entity-unsubscribed',
              '2026-04-10T10:00:00.000Z',
              '2026-04-10T10:00:00.000Z'
            ),
            (
              '20000000-0000-0000-0000-000000000005',
              'user-unsubscribed',
              NULL,
              'global_unsubscribe',
              FALSE,
              '{"channels":{"email":false}}'::jsonb,
              'hash-unsubscribe',
              '2026-04-10T15:00:00.000Z',
              '2026-04-10T15:00:00.000Z'
            ),
            (
              '20000000-0000-0000-0000-000000000006',
              'user-no-global',
              '11111111',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-no-global',
              '2026-04-10T16:00:00.000Z',
              '2026-04-10T16:00:00.000Z'
            )
        `);

        await client.query(`
          INSERT INTO notificationsoutbox (
            id,
            user_id,
            notification_type,
            reference_id,
            scope_key,
            delivery_key,
            status,
            attempt_count,
            sent_at,
            metadata,
            created_at
          )
          VALUES
            (
              '30000000-0000-0000-0000-000000000001',
              'user-outbox-only',
              'funky:outbox:entity_update',
              'notif-4444-update',
              'funky:delivery:entity-update-44444444',
              'entity-update-user-outbox-only-44444444',
              'delivered',
              1,
              '2026-04-10T16:01:00.000Z'::timestamptz,
              jsonb_build_object('campaignKey', 'funky', 'entityCui', '44444444'),
              '2026-04-10T16:00:00.000Z'::timestamptz
            )
        `);
      });

      const repo = makeLearningProgressRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });

      const firstPage = await repo.listCampaignAdminUsers({
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        entityCui: '11111111',
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        limit: 2,
      });

      expect(firstPage.isOk()).toBe(true);
      if (firstPage.isErr()) {
        return;
      }

      expect(firstPage.value.items).toEqual([
        {
          userId: 'user-subscriber',
          interactionCount: 0,
          pendingReviewCount: 0,
          latestUpdatedAt: '2026-04-10T14:00:00.000Z',
          latestInteractionId: null,
          latestEntityCui: '11111111',
        },
        {
          userId: 'user-beta',
          interactionCount: 1,
          pendingReviewCount: 0,
          latestUpdatedAt: '2026-04-10T12:00:00.000Z',
          latestInteractionId: 'funky:interaction:public_debate_request',
          latestEntityCui: '11111111',
        },
      ]);
      expect(firstPage.value.hasMore).toBe(true);
      expect(firstPage.value.nextCursor).toEqual({
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        userId: 'user-beta',
        value: '2026-04-10T12:00:00.000Z',
      });

      const secondPage = await repo.listCampaignAdminUsers({
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        entityCui: '11111111',
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        limit: 2,
        ...(firstPage.value.nextCursor !== null ? { cursor: firstPage.value.nextCursor } : {}),
      });

      expect(secondPage.isOk()).toBe(true);
      if (secondPage.isErr()) {
        return;
      }

      expect(secondPage.value.items).toEqual([
        {
          userId: 'user-alpha',
          interactionCount: 1,
          pendingReviewCount: 1,
          latestUpdatedAt: '2026-04-10T11:00:00.000Z',
          latestInteractionId: 'funky:interaction:public_debate_request',
          latestEntityCui: '11111111',
        },
      ]);
      expect(secondPage.value.hasMore).toBe(false);
      expect(secondPage.value.nextCursor).toBeNull();

      const filtered = await repo.listCampaignAdminUsers({
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        entityCui: '11111111',
        query: 'subscriber',
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        limit: 10,
      });

      expect(filtered.isOk()).toBe(true);
      if (filtered.isErr()) {
        return;
      }

      expect(filtered.value.items).toEqual([
        {
          userId: 'user-subscriber',
          interactionCount: 0,
          pendingReviewCount: 0,
          latestUpdatedAt: '2026-04-10T14:00:00.000Z',
          latestInteractionId: null,
          latestEntityCui: '11111111',
        },
      ]);

      const outboxOnly = await repo.listCampaignAdminUsers({
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
        entityCui: '44444444',
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        limit: 10,
      });

      expect(outboxOnly.isOk()).toBe(true);
      if (outboxOnly.isErr()) {
        return;
      }

      expect(outboxOnly.value.items).toEqual([]);
      expect(outboxOnly.value.hasMore).toBe(false);
      expect(outboxOnly.value.nextCursor).toBeNull();
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });
});
