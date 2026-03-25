import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { dockerAvailable } from './setup.js';

const OLD_USER_INTERACTIONS_SCHEMA = `
CREATE SEQUENCE learningprogress_updated_seq;

CREATE TABLE LearningProgress (
  user_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  audit_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_seq BIGINT NOT NULL DEFAULT nextval('learningprogress_updated_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, record_key)
);

CREATE INDEX idx_learningprogress_user_updated_seq
ON LearningProgress(user_id, updated_seq);

CREATE INDEX idx_learningprogress_review_pending_updated_at
ON LearningProgress (((record->>'updatedAt')::timestamptz) DESC, user_id, record_key)
WHERE record->>'phase' = 'pending';

CREATE INDEX idx_learningprogress_review_status_updated_at
ON LearningProgress (
  ((record->'review'->>'status')),
  ((record->>'updatedAt')::timestamptz) DESC,
  user_id,
  record_key
)
WHERE record ? 'review';
`;

const USER_INTERACTIONS_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202603251030_rename_learning_progress_to_user_interactions.sql'
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

describe('UserInteractions migration', () => {
  it('drops legacy storage, creates fresh user interactions storage, and leaves row updated_at trigger-free', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(OLD_USER_INTERACTIONS_SCHEMA);

        await client.query(
          `
            INSERT INTO LearningProgress (
              user_id,
              record_key,
              record,
              audit_events,
              updated_seq,
              created_at,
              updated_at
            )
            VALUES
              ($1, $2, $3::jsonb, $4::jsonb, 1, $5::timestamptz, $5::timestamptz),
              ($1, $6, $7::jsonb, $8::jsonb, 2, $9::timestamptz, $9::timestamptz)
          `,
          [
            'user-1',
            'review/pending/a',
            JSON.stringify({
              key: 'review/pending/a',
              lessonId: 'lesson-1',
              interactionId: 'interaction-1',
              kind: 'quiz',
              scope: { type: 'global' },
              completionRule: { type: 'outcome', outcome: 'correct' },
              phase: 'pending',
              value: { kind: 'choice', choice: { selectedId: 'option-a' } },
              result: null,
              updatedAt: '2026-03-24T10:00:00.000Z',
              submittedAt: '2026-03-24T10:00:00.000Z',
            }),
            JSON.stringify([
              {
                id: 'submitted-1',
                recordKey: 'review/pending/a',
                lessonId: 'lesson-1',
                interactionId: 'interaction-1',
                type: 'submitted',
                at: '2026-03-24T10:00:00.000Z',
                actor: 'user',
                value: { kind: 'choice', choice: { selectedId: 'option-a' } },
                seq: '1',
                sourceClientEventId: 'client-event-1',
                sourceClientId: 'client-1',
              },
            ]),
            '2026-03-24T10:00:00.000Z',
            'reviewed/pending/b',
            JSON.stringify({
              key: 'reviewed/pending/b',
              lessonId: 'lesson-2',
              interactionId: 'interaction-2',
              kind: 'custom',
              scope: { type: 'entity', entityCui: '4305857' },
              completionRule: { type: 'resolved' },
              phase: 'resolved',
              value: {
                kind: 'json',
                json: { value: { websiteUrl: 'https://example.com' } },
              },
              result: { outcome: null },
              review: { status: 'approved', reviewedAt: '2026-03-24T10:05:00.000Z' },
              updatedAt: '2026-03-24T10:05:00.000Z',
            }),
            JSON.stringify([
              {
                id: 'evaluated-1',
                recordKey: 'reviewed/pending/b',
                lessonId: 'lesson-2',
                interactionId: 'interaction-2',
                type: 'evaluated',
                at: '2026-03-24T10:05:00.000Z',
                actor: 'system',
                phase: 'resolved',
                result: { outcome: null, evaluatedAt: '2026-03-24T10:05:00.000Z' },
                seq: '2',
                sourceClientEventId: 'server-review-1',
                sourceClientId: 'server-review',
              },
            ]),
            '2026-03-24T10:05:00.000Z',
          ]
        );

        await client.query(USER_INTERACTIONS_MIGRATION);

        const rows = await client.query<{
          record_key: string;
          record: { key: string };
          audit_events: { recordKey: string }[];
        }>(
          `
            SELECT record_key, record, audit_events
            FROM UserInteractions
            ORDER BY record_key ASC
          `
        );

        expect(rows.rows).toEqual([]);

        const legacyTable = await client.query<{ to_regclass: string | null }>(
          `SELECT to_regclass('public.learningprogress')`
        );
        expect(legacyTable.rows[0]?.to_regclass).toBeNull();

        await client.query(
          `
            INSERT INTO UserInteractions (user_id, record_key, record, audit_events, updated_seq)
            VALUES (
              'user-1',
              'review/pending/a',
              '{"key":"review/pending/a","phase":"pending","updatedAt":"2026-03-24T10:00:00.000Z"}'::jsonb,
              '[]'::jsonb,
              1
            ),
            (
              'user-1',
              'reviewed/pending/b',
              '{"key":"reviewed/pending/b","phase":"resolved","review":{"status":"approved"},"updatedAt":"2026-03-24T10:05:00.000Z"}'::jsonb,
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
                'idx_userinteractions_user_record_key_prefix',
                'idx_userinteractions_record_key_prefix',
                'idx_userinteractions_review_pending_updated_at',
                'idx_userinteractions_review_status_updated_at'
              )
            ORDER BY indexname ASC
          `
        );
        expect(indexes.rows.map((row) => row.indexname)).toEqual([
          'idx_userinteractions_record_key_prefix',
          'idx_userinteractions_review_pending_updated_at',
          'idx_userinteractions_review_status_updated_at',
          'idx_userinteractions_user_record_key_prefix',
        ]);

        const trigger = await client.query<{ tgname: string }>(
          `
            SELECT tgname
            FROM pg_trigger
            WHERE tgrelid = 'userinteractions'::regclass
              AND NOT tgisinternal
          `
        );
        expect(trigger.rows).toEqual([]);

        await client.query('ANALYZE UserInteractions');
        await client.query('SET enable_seqscan = off');

        const prefixExplain = await client.query(
          `
            EXPLAIN
            SELECT record_key
            FROM UserInteractions
            WHERE user_id = 'user-1'
              AND record_key LIKE 'review/%' ESCAPE '\\'
          `
        );

        expect(
          prefixExplain.rows
            .map((row) => String((row as Record<string, unknown>)['QUERY PLAN']))
            .join('\n')
        ).toContain('idx_userinteractions_user_record_key_prefix');

        const reviewExplain = await client.query(
          `
            EXPLAIN
            SELECT record_key
            FROM UserInteractions
            WHERE record->>'phase' = 'pending'
            ORDER BY updated_at DESC, user_id ASC, record_key ASC
            LIMIT 10
          `
        );

        expect(
          reviewExplain.rows
            .map((row) => String((row as Record<string, unknown>)['QUERY PLAN']))
            .join('\n')
        ).toContain('idx_userinteractions_review_pending_updated_at');
      });
    } finally {
      await database.stop();
    }
  });

  it('supports escaped raw prefix matching for literal wildcard characters', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(OLD_USER_INTERACTIONS_SCHEMA);
        await client.query(USER_INTERACTIONS_MIGRATION);

        await client.query(
          `
            INSERT INTO UserInteractions (user_id, record_key, record, audit_events, updated_seq)
            VALUES
              ('user-1', 'literal_%/a', '{"key":"literal_%/a"}'::jsonb, '[]'::jsonb, 1),
              ('user-1', 'literal-x/a', '{"key":"literal-x/a"}'::jsonb, '[]'::jsonb, 2)
          `
        );

        const rows = await client.query<{ record_key: string }>(
          `
            SELECT record_key
            FROM UserInteractions
            WHERE user_id = 'user-1'
              AND record_key LIKE 'literal\\_\\%%' ESCAPE '\\'
            ORDER BY record_key ASC
          `
        );

        expect(rows.rows.map((row) => row.record_key)).toEqual(['literal_%/a']);
      });
    } finally {
      await database.stop();
    }
  });
});
