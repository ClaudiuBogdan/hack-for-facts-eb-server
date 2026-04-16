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

describe('Learning progress auto-review reuse repo query', () => {
  it('returns the full latest-precedence group for an exact-key match', async () => {
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
              'reviewer-a',
              'funky:interaction:city_hall_website::entity:12345678',
              '{
                "key":"funky:interaction:city_hall_website::entity:12345678",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"12345678"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{"kind":"json","json":{"value":{"websiteUrl":"https://primarie.test","submittedAt":"2026-04-16T09:00:00.000Z"}}},
                "result":null,
                "review":{"status":"approved","reviewedAt":"2026-04-16T09:00:00.000Z","reviewSource":"campaign_admin_api"},
                "updatedAt":"2026-04-16T09:00:00.000Z",
                "submittedAt":"2026-04-16T09:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              1,
              '2026-04-16T09:00:00.000Z',
              '2026-04-16T09:00:00.000Z'
            ),
            (
              'reviewer-b',
              'funky:interaction:city_hall_website::entity:12345678',
              '{
                "key":"funky:interaction:city_hall_website::entity:12345678",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"12345678"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{"kind":"json","json":{"value":{"websiteUrl":"https://primarie.test","submittedAt":"2026-04-16T09:00:00.000Z"}}},
                "result":null,
                "review":{"status":"approved","reviewedAt":"2026-04-16T09:00:00.000Z","reviewSource":"campaign_admin_api"},
                "updatedAt":"2026-04-16T09:00:00.000Z",
                "submittedAt":"2026-04-16T09:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              2,
              '2026-04-16T09:00:00.000Z',
              '2026-04-16T09:00:00.000Z'
            ),
            (
              'older-reviewer',
              'funky:interaction:city_hall_website::entity:12345678',
              '{
                "key":"funky:interaction:city_hall_website::entity:12345678",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"12345678"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{"kind":"json","json":{"value":{"websiteUrl":"https://primarie-older.test","submittedAt":"2026-04-16T08:00:00.000Z"}}},
                "result":null,
                "review":{"status":"approved","reviewedAt":"2026-04-16T08:00:00.000Z","reviewSource":"campaign_admin_api"},
                "updatedAt":"2026-04-16T08:00:00.000Z",
                "submittedAt":"2026-04-16T08:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              3,
              '2026-04-16T08:00:00.000Z',
              '2026-04-16T08:00:00.000Z'
            ),
            (
              'wrong-entity',
              'funky:interaction:city_hall_website::entity:99999999',
              '{
                "key":"funky:interaction:city_hall_website::entity:99999999",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"99999999"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{"kind":"json","json":{"value":{"websiteUrl":"https://primarie-99999999.test","submittedAt":"2026-04-16T09:00:00.000Z"}}},
                "result":null,
                "review":{"status":"approved","reviewedAt":"2026-04-16T09:00:00.000Z","reviewSource":"campaign_admin_api"},
                "updatedAt":"2026-04-16T09:00:00.000Z",
                "submittedAt":"2026-04-16T09:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              4,
              '2026-04-16T09:00:00.000Z',
              '2026-04-16T09:00:00.000Z'
            ),
            (
              'auto-review',
              'funky:interaction:city_hall_website::entity:12345678',
              '{
                "key":"funky:interaction:city_hall_website::entity:12345678",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"12345678"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{"kind":"json","json":{"value":{"websiteUrl":"https://primarie.test","submittedAt":"2026-04-16T09:00:00.000Z"}}},
                "result":null,
                "review":{"status":"approved","reviewedAt":"2026-04-16T09:00:00.000Z","reviewSource":"auto_review_reuse_match"},
                "updatedAt":"2026-04-16T09:00:00.000Z",
                "submittedAt":"2026-04-16T09:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              5,
              '2026-04-16T09:00:00.000Z',
              '2026-04-16T09:00:00.000Z'
            )
        `);
      });

      const repo = makeLearningProgressRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const result = await repo.findLatestCampaignAdminReviewedExactKeyMatches({
        recordKey: 'funky:interaction:city_hall_website::entity:12345678',
        interactionId: 'funky:interaction:city_hall_website',
        entityCui: '12345678',
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().map((row) => row.userId)).toEqual(['reviewer-a', 'reviewer-b']);
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('ignores older approvals when the latest reviewed row is rejected', async () => {
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
              'older-admin',
              'funky:interaction:budget_document::entity:12345678',
              '{
                "key":"funky:interaction:budget_document::entity:12345678",
                "interactionId":"funky:interaction:budget_document",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"12345678"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{"kind":"json","json":{"value":{"documentUrl":"https://primarie.test/buget.pdf","documentTypes":["pdf"],"submittedAt":"2026-04-16T08:00:00.000Z"}}},
                "result":null,
                "review":{"status":"approved","reviewedAt":"2026-04-16T08:00:00.000Z","reviewSource":"campaign_admin_api"},
                "updatedAt":"2026-04-16T08:00:00.000Z",
                "submittedAt":"2026-04-16T08:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              1,
              '2026-04-16T08:00:00.000Z',
              '2026-04-16T08:00:00.000Z'
            ),
            (
              'latest-admin',
              'funky:interaction:budget_document::entity:12345678',
              '{
                "key":"funky:interaction:budget_document::entity:12345678",
                "interactionId":"funky:interaction:budget_document",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"12345678"},
                "completionRule":{"type":"resolved"},
                "phase":"failed",
                "value":{"kind":"json","json":{"value":{"documentUrl":"https://primarie.test/buget.pdf","documentTypes":["pdf"],"submittedAt":"2026-04-16T09:00:00.000Z"}}},
                "result":null,
                "review":{"status":"rejected","reviewedAt":"2026-04-16T09:00:00.000Z","reviewSource":"campaign_admin_api","feedbackText":"Rejected"} ,
                "updatedAt":"2026-04-16T09:00:00.000Z",
                "submittedAt":"2026-04-16T09:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              2,
              '2026-04-16T09:00:00.000Z',
              '2026-04-16T09:00:00.000Z'
            )
        `);
      });

      const repo = makeLearningProgressRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const result = await repo.findLatestCampaignAdminReviewedExactKeyMatches({
        recordKey: 'funky:interaction:budget_document::entity:12345678',
        interactionId: 'funky:interaction:budget_document',
        entityCui: '12345678',
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(1);
      expect(result._unsafeUnwrap()[0]?.userId).toBe('latest-admin');
      expect(result._unsafeUnwrap()[0]?.record.review?.reviewSource).toBe('campaign_admin_api');
      expect(result._unsafeUnwrap()[0]?.record.review?.status).toBe('rejected');
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });
});
