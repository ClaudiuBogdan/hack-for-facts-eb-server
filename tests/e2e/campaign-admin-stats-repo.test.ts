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

describe('Learning progress repo campaign-admin stats', () => {
  it('aggregates campaign-wide stats and grouped risk candidates from Postgres', async () => {
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
                      "primariaEmail":"invalid-email",
                      "submissionPath":"request_platform",
                      "submittedAt":"2026-04-10T11:00:00.000Z"
                    }
                  }
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
              'user-2',
              'funky:interaction:public_debate_request::entity:87654321',
              '{
                "key":"funky:interaction:public_debate_request::entity:87654321",
                "interactionId":"funky:interaction:public_debate_request",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"87654321"},
                "completionRule":{"type":"resolved"},
                "phase":"resolved",
                "value":{
                  "kind":"json",
                  "json":{
                    "value":{
                      "primariaEmail":"contact@primarie-2.ro",
                      "submissionPath":"request_platform",
                      "submittedAt":"2026-04-10T10:00:00.000Z"
                    }
                  }
                },
                "result":null,
                "review":{
                  "status":"approved",
                  "reviewedAt":"2026-04-10T10:30:00.000Z"
                },
                "updatedAt":"2026-04-10T10:00:00.000Z",
                "submittedAt":"2026-04-10T10:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              2,
              '2026-04-10T10:00:00.000Z',
              '2026-04-10T10:00:00.000Z'
            ),
            (
              'user-3',
              'funky:interaction:city_hall_website::entity:11111111',
              '{
                "key":"funky:interaction:city_hall_website::entity:11111111",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"11111111"},
                "completionRule":{"type":"resolved"},
                "phase":"failed",
                "value":{
                  "kind":"json",
                  "json":{
                    "value":{
                      "websiteUrl":"https://primarie-11111111.test"
                    }
                  }
                },
                "result":null,
                "review":{
                  "status":"rejected",
                  "reviewedAt":"2026-04-10T09:30:00.000Z"
                },
                "updatedAt":"2026-04-10T09:00:00.000Z",
                "submittedAt":"2026-04-10T09:00:00.000Z"
              }'::jsonb,
              '[]'::jsonb,
              3,
              '2026-04-10T09:00:00.000Z',
              '2026-04-10T09:00:00.000Z'
            ),
            (
              'user-4',
              'funky:interaction:city_hall_website::entity:22222222',
              '{
                "key":"funky:interaction:city_hall_website::entity:22222222",
                "interactionId":"funky:interaction:city_hall_website",
                "lessonId":"civic-monitor-and-request",
                "kind":"custom",
                "scope":{"type":"entity","entityCui":"22222222"},
                "completionRule":{"type":"resolved"},
                "phase":"draft",
                "value":{
                  "kind":"json",
                  "json":{
                    "value":{
                      "websiteUrl":"https://primarie-22222222.test"
                    }
                  }
                },
                "result":null,
                "updatedAt":"2026-04-10T08:00:00.000Z",
                "submittedAt":null
              }'::jsonb,
              '[]'::jsonb,
              4,
              '2026-04-10T08:00:00.000Z',
              '2026-04-10T08:00:00.000Z'
            )
        `);

        await client.query(`
          INSERT INTO institutionemailthreads (
            id,
            entity_cui,
            campaign_key,
            thread_key,
            phase,
            last_email_at,
            next_action_at,
            record,
            created_at,
            updated_at
          )
          VALUES (
            '00000000-0000-0000-0000-000000000001',
            '87654321',
            'funky',
            'thread-1',
            'failed',
            '2026-04-10T10:15:00.000Z',
            '2026-04-10T11:00:00.000Z',
            '{"submissionPath":"platform_send","metadata":{"interactionKey":"funky:interaction:public_debate_request::entity:87654321"}}'::jsonb,
            '2026-04-10T10:15:00.000Z',
            '2026-04-10T10:15:00.000Z'
          )
        `);
      });

      const repo = makeLearningProgressRepo({
        db: userDb,
        logger: pinoLogger({ level: 'silent' }),
      });
      const result = await repo.getCampaignAdminStats({
        campaignKey: 'funky',
        reviewableInteractions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            reviewableSubmissionPath: 'request_platform',
          },
          {
            interactionId: 'funky:interaction:city_hall_website',
          },
        ],
      });

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }

      expect(result.value.stats).toEqual({
        total: 4,
        withInstitutionThread: 1,
        reviewStatusCounts: {
          pending: 1,
          approved: 1,
          rejected: 1,
          notReviewed: 1,
        },
        phaseCounts: {
          idle: 0,
          draft: 1,
          pending: 1,
          resolved: 1,
          failed: 1,
        },
        threadPhaseCounts: {
          sending: 0,
          awaiting_reply: 0,
          reply_received_unreviewed: 0,
          manual_follow_up_needed: 0,
          resolved_positive: 0,
          resolved_negative: 0,
          closed_no_response: 0,
          failed: 1,
          none: 3,
        },
      });

      const publicDebateRiskCandidates = result.value.riskFlagCandidates
        .filter(
          (candidate) => candidate.interactionId === 'funky:interaction:public_debate_request'
        )
        .sort((left, right) => left.entityCui!.localeCompare(right.entityCui!));

      expect(publicDebateRiskCandidates).toEqual([
        {
          interactionId: 'funky:interaction:public_debate_request',
          entityCui: '12345678',
          institutionEmail: 'invalid-email',
          threadPhase: null,
          count: 1,
        },
        {
          interactionId: 'funky:interaction:public_debate_request',
          entityCui: '87654321',
          institutionEmail: 'contact@primarie-2.ro',
          threadPhase: 'failed',
          count: 1,
        },
      ]);
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });
});
