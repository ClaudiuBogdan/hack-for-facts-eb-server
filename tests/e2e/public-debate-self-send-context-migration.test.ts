import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { dockerAvailable } from './setup.js';

const USER_INTERACTIONS_SCHEMA = `
CREATE SEQUENCE userinteractions_updated_seq;

CREATE TABLE UserInteractions (
  user_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  audit_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_seq BIGINT NOT NULL DEFAULT nextval('userinteractions_updated_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, record_key)
);
`;

const PUBLIC_DEBATE_SELF_SEND_GUARD_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202604011100_guard_public_debate_self_send_context.sql'
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

describe('Public debate self-send context rollout guard migration', () => {
  it('succeeds when all send_yourself records already include ngoSenderEmail and preparedSubject', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_INTERACTIONS_SCHEMA);
        await client.query(
          `
            INSERT INTO UserInteractions (user_id, record_key, record, audit_events)
            VALUES
              (
                'user-1',
                'funky:interaction:public_debate_request::entity:12345678',
                $1::jsonb,
                '[]'::jsonb
              ),
              (
                'user-2',
                'funky:interaction:public_debate_request::entity:87654321',
                $2::jsonb,
                '[]'::jsonb
              )
          `,
          [
            JSON.stringify({
              key: 'funky:interaction:public_debate_request::entity:12345678',
              interactionId: 'funky:interaction:public_debate_request',
              phase: 'pending',
              value: {
                kind: 'json',
                json: {
                  value: {
                    submissionPath: 'send_yourself',
                    ngoSenderEmail: 'ngo@example.com',
                    preparedSubject: 'Cerere organizare dezbatere publica',
                    threadKey: 'legacy-thread-key',
                  },
                },
              },
            }),
            JSON.stringify({
              key: 'funky:interaction:public_debate_request::entity:87654321',
              interactionId: 'funky:interaction:public_debate_request',
              phase: 'pending',
              value: {
                kind: 'json',
                json: {
                  value: {
                    submissionPath: 'request_platform',
                    ngoSenderEmail: null,
                    preparedSubject: null,
                  },
                },
              },
            }),
          ]
        );

        await client.query(PUBLIC_DEBATE_SELF_SEND_GUARD_MIGRATION);

        const rows = await client.query<{ record_key: string }>(
          `
            SELECT record_key
            FROM UserInteractions
            ORDER BY record_key ASC
          `
        );

        expect(rows.rows.map((row) => row.record_key)).toEqual([
          'funky:interaction:public_debate_request::entity:12345678',
          'funky:interaction:public_debate_request::entity:87654321',
        ]);
      });
    } finally {
      await database.stop();
    }
  });

  it('fails with a clear error when legacy send_yourself records are missing ngoSenderEmail or preparedSubject', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_INTERACTIONS_SCHEMA);
        await client.query(
          `
            INSERT INTO UserInteractions (user_id, record_key, record, audit_events)
            VALUES (
              'user-1',
              'funky:interaction:public_debate_request::entity:12345678',
              $1::jsonb,
              '[]'::jsonb
            )
          `,
          [
            JSON.stringify({
              key: 'funky:interaction:public_debate_request::entity:12345678',
              interactionId: 'funky:interaction:public_debate_request',
              phase: 'pending',
              value: {
                kind: 'json',
                json: {
                  value: {
                    submissionPath: 'send_yourself',
                    ngoSenderEmail: null,
                    preparedSubject: null,
                    threadKey: 'legacy-thread-key',
                  },
                },
              },
            }),
          ]
        );

        let migrationError: (Error & { detail?: string }) | null = null;
        try {
          await client.query(PUBLIC_DEBATE_SELF_SEND_GUARD_MIGRATION);
        } catch (error) {
          migrationError = error as Error & { detail?: string };
        }

        expect(migrationError).not.toBeNull();
        expect(migrationError?.message).toContain(
          'Public debate self-send rollout blocked: found send_yourself interactions missing ngoSenderEmail or preparedSubject.'
        );
        expect(migrationError?.detail).toContain(
          'record_key=funky:interaction:public_debate_request::entity:12345678'
        );
      });
    } finally {
      await database.stop();
    }
  });
});
