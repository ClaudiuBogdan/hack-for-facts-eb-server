import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { dockerAvailable } from './setup.js';

const USER_SCHEMA_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202604021100_unify_production_user_schema.sql'
  ),
  'utf-8'
);

const CAMPAIGN_ADMIN_INDEX_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202604102200_add_campaign_admin_user_interaction_indexes.sql'
  ),
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

describe('Campaign admin user-interaction indexes', () => {
  it('adds Funky campaign review indexes that support entity and submission-path filtering', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA_MIGRATION);
        await client.query(CAMPAIGN_ADMIN_INDEX_MIGRATION);

        await client.query(
          `
            INSERT INTO userinteractions (user_id, record_key, record, audit_events, updated_seq)
            VALUES
              (
                'user-1',
                'funky:interaction:public_debate_request::entity:12345678',
                '{
                  "key":"funky:interaction:public_debate_request::entity:12345678",
                  "interactionId":"funky:interaction:public_debate_request",
                  "lessonId":"civic-monitor-and-request",
                  "kind":"custom",
                  "scope":{"type":"entity","entityCui":"12345678"},
                  "completionRule":{"type":"resolved"},
                  "phase":"pending",
                  "value":{
                    "kind":"json",
                    "json":{
                      "value":{
                        "primariaEmail":"contact@primarie.ro",
                        "submissionPath":"request_platform",
                        "submittedAt":"2026-04-10T10:00:00.000Z"
                      }
                    }
                  },
                  "result":null,
                  "updatedAt":"2026-04-10T10:00:00.000Z",
                  "submittedAt":"2026-04-10T10:00:00.000Z"
                }'::jsonb,
                '[]'::jsonb,
                1
              ),
              (
                'user-3',
                'funky:interaction:budget_contestation::entity:11112222',
                '{
                  "key":"funky:interaction:budget_contestation::entity:11112222",
                  "interactionId":"funky:interaction:budget_contestation",
                  "lessonId":"civic-participate-and-act",
                  "kind":"custom",
                  "scope":{"type":"entity","entityCui":"11112222"},
                  "completionRule":{"type":"resolved"},
                  "phase":"pending",
                  "value":{
                    "kind":"json",
                    "json":{
                      "value":{
                        "submissionPath":"send_email",
                        "submittedAt":"2026-04-10T08:00:00.000Z"
                      }
                    }
                  },
                  "result":null,
                  "updatedAt":"2026-04-10T08:00:00.000Z",
                  "submittedAt":"2026-04-10T08:00:00.000Z"
                }'::jsonb,
                '[]'::jsonb,
                3
              ),
              (
                'user-2',
                'other:interaction::entity:87654321',
                '{
                  "key":"other:interaction::entity:87654321",
                  "interactionId":"other:interaction",
                  "lessonId":"other-lesson",
                  "kind":"custom",
                  "scope":{"type":"entity","entityCui":"87654321"},
                  "completionRule":{"type":"resolved"},
                  "phase":"pending",
                  "value":{
                    "kind":"json",
                    "json":{
                      "value":{
                        "submissionPath":"send_yourself",
                        "submittedAt":"2026-04-10T09:00:00.000Z"
                      }
                    }
                  },
                  "result":null,
                  "updatedAt":"2026-04-10T09:00:00.000Z",
                  "submittedAt":"2026-04-10T09:00:00.000Z"
                }'::jsonb,
                '[]'::jsonb,
                2
              )
          `
        );

        const indexes = await client.query<{ indexname: string }>(
          `
            SELECT indexname
            FROM pg_indexes
            WHERE tablename = 'userinteractions'
              AND indexname IN (
                'idx_userinteractions_funky_review_updated_at',
                'idx_userinteractions_funky_review_entity_updated_at',
                'idx_userinteractions_funky_review_submission_path_updated_at'
              )
            ORDER BY indexname ASC
          `
        );

        expect(indexes.rows.map((row) => row.indexname)).toEqual([
          'idx_userinteractions_funky_review_entity_updated_at',
          'idx_userinteractions_funky_review_submission_path_updated_at',
          'idx_userinteractions_funky_review_updated_at',
        ]);

        await client.query('ANALYZE userinteractions');
        await client.query('SET enable_seqscan = off');

        const entityExplain = await client.query(
          `
            EXPLAIN
            SELECT record_key
            FROM userinteractions
            WHERE record->>'interactionId' = 'funky:interaction:public_debate_request'
              AND record->'scope'->>'entityCui' = '12345678'
            ORDER BY updated_at DESC, user_id ASC, record_key ASC
            LIMIT 10
          `
        );

        expect(
          entityExplain.rows
            .map((row) => String((row as Record<string, unknown>)['QUERY PLAN']))
            .join('\n')
        ).toContain('idx_userinteractions_funky_review_entity_updated_at');

        const submissionPathExplain = await client.query(
          `
            EXPLAIN
            SELECT record_key
            FROM userinteractions
            WHERE record->>'interactionId' = 'funky:interaction:budget_contestation'
              AND record->'value'->'json'->'value'->>'submissionPath' = 'send_email'
            ORDER BY updated_at DESC, user_id ASC, record_key ASC
            LIMIT 10
          `
        );

        expect(
          submissionPathExplain.rows
            .map((row) => String((row as Record<string, unknown>)['QUERY PLAN']))
            .join('\n')
        ).toContain('idx_userinteractions_funky_review_submission_path_updated_at');
      });
    } finally {
      await database.stop();
    }
  });
});
