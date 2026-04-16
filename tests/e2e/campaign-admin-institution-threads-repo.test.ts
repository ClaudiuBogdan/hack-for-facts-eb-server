import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import {
  appendCampaignAdminThreadResponse,
  createConflictError,
  makeInstitutionCorrespondenceRepo,
  projectCampaignAdminThread,
} from '@/modules/institution-correspondence/index.js';
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

describe('institution correspondence repo campaign-admin threads', () => {
  it('applies v1 campaign-admin list filters, excludes failed threads, and keeps totalCount stable across cursors', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);
    const repo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger: pinoLogger({ enabled: false }),
    });

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO institutionemailthreads (
            id,
            entity_cui,
            campaign_key,
            thread_key,
            phase,
            last_email_at,
            last_reply_at,
            next_action_at,
            closed_at,
            record,
            created_at,
            updated_at
          )
          VALUES
            (
              '10000000-0000-0000-0000-000000000001',
              '91000001',
              'funky',
              'funky-thread-1',
              'awaiting_reply',
              '2026-04-10T10:00:00.000Z'::timestamptz,
              NULL,
              NULL,
              NULL,
              '{
                "version":1,
                "campaign":"funky",
                "campaignKey":"funky",
                "ownerUserId":"owner-a",
                "subject":"Thread 1",
                "submissionPath":"platform_send",
                "institutionEmail":"alpha@scope.test",
                "ngoIdentity":"funky_citizens",
                "requesterOrganizationName":null,
                "budgetPublicationDate":null,
                "consentCapturedAt":null,
                "contestationDeadlineAt":null,
                "captureAddress":"contact@test",
                "correspondence":[],
                "latestReview":null,
                "metadata":{}
              }'::jsonb,
              '2026-04-10T10:00:00.000Z'::timestamptz,
              '2026-04-10T10:00:00.000Z'::timestamptz
            ),
            (
              '10000000-0000-0000-0000-000000000002',
              '91000002',
              'funky',
              'funky-thread-2',
              'reply_received_unreviewed',
              '2026-04-12T10:00:00.000Z'::timestamptz,
              '2026-04-12T11:00:00.000Z'::timestamptz,
              '2026-04-12T11:00:00.000Z'::timestamptz,
              NULL,
              '{
                "version":1,
                "campaign":"funky",
                "campaignKey":"funky",
                "ownerUserId":"owner-b",
                "subject":"Thread 2",
                "submissionPath":"platform_send",
                "institutionEmail":"beta@scope.test",
                "ngoIdentity":"funky_citizens",
                "requesterOrganizationName":null,
                "budgetPublicationDate":null,
                "consentCapturedAt":null,
                "contestationDeadlineAt":null,
                "captureAddress":"contact@test",
                "correspondence":[],
                "latestReview":null,
                "metadata":{}
              }'::jsonb,
              '2026-04-12T10:00:00.000Z'::timestamptz,
              '2026-04-12T12:00:00.000Z'::timestamptz
            ),
            (
              '10000000-0000-0000-0000-000000000003',
              '91000003',
              'funky',
              'funky-thread-3',
              'awaiting_reply',
              '2026-04-13T10:00:00.000Z'::timestamptz,
              NULL,
              NULL,
              NULL,
              '{
                "version":1,
                "campaign":"funky",
                "campaignKey":"funky",
                "ownerUserId":"owner-c",
                "subject":"Thread 3",
                "submissionPath":"platform_send",
                "institutionEmail":"gamma@scope.test",
                "ngoIdentity":"funky_citizens",
                "requesterOrganizationName":null,
                "budgetPublicationDate":null,
                "consentCapturedAt":null,
                "contestationDeadlineAt":null,
                "captureAddress":"contact@test",
                "correspondence":[],
                "latestReview":null,
                "adminWorkflow":{
                  "currentResponseStatus":"request_denied",
                  "responseEvents":[
                    {
                      "id":"response-1",
                      "responseDate":"2026-04-13T09:30:00.000Z",
                      "messageContent":"Denied",
                      "responseStatus":"request_denied",
                      "actorUserId":"admin-1",
                      "createdAt":"2026-04-13T09:31:00.000Z",
                      "source":"campaign_admin_api"
                    }
                  ]
                },
                "metadata":{}
              }'::jsonb,
              '2026-04-13T10:00:00.000Z'::timestamptz,
              '2026-04-13T12:00:00.000Z'::timestamptz
            ),
            (
              '10000000-0000-0000-0000-000000000004',
              '91000004',
              'funky',
              'funky-thread-4',
              'failed',
              '2026-04-14T10:00:00.000Z'::timestamptz,
              NULL,
              NULL,
              NULL,
              '{
                "version":1,
                "campaign":"funky",
                "campaignKey":"funky",
                "ownerUserId":"owner-d",
                "subject":"Failed thread",
                "submissionPath":"platform_send",
                "institutionEmail":"failed@scope.test",
                "ngoIdentity":"funky_citizens",
                "requesterOrganizationName":null,
                "budgetPublicationDate":null,
                "consentCapturedAt":null,
                "contestationDeadlineAt":null,
                "captureAddress":"contact@test",
                "correspondence":[],
                "latestReview":null,
                "metadata":{}
              }'::jsonb,
              '2026-04-14T10:00:00.000Z'::timestamptz,
              '2026-04-14T12:00:00.000Z'::timestamptz
            ),
            (
              '10000000-0000-0000-0000-000000000005',
              '91000005',
              'funky',
              'funky-thread-5',
              'awaiting_reply',
              '2026-04-14T10:00:00.000Z'::timestamptz,
              NULL,
              NULL,
              NULL,
              '{
                "version":1,
                "campaign":"funky",
                "campaignKey":"funky",
                "ownerUserId":"owner-e",
                "subject":"Self send",
                "submissionPath":"self_send_cc",
                "institutionEmail":"self@scope.test",
                "ngoIdentity":"funky_citizens",
                "requesterOrganizationName":null,
                "budgetPublicationDate":null,
                "consentCapturedAt":null,
                "contestationDeadlineAt":null,
                "captureAddress":"contact@test",
                "correspondence":[],
                "latestReview":null,
                "metadata":{"interactionKey":"self-1"}
              }'::jsonb,
              '2026-04-14T10:00:00.000Z'::timestamptz,
              '2026-04-14T12:00:00.000Z'::timestamptz
            );
        `);
      });

      const openPage = await repo.listCampaignAdminThreads({
        campaignKey: 'funky',
        stateGroup: 'open',
        limit: 1,
      });
      expect(openPage.isOk()).toBe(true);
      if (openPage.isErr()) {
        return;
      }

      expect(openPage.value.items).toHaveLength(1);
      expect(openPage.value.items[0]?.id).toBe('10000000-0000-0000-0000-000000000002');
      expect(openPage.value.totalCount).toBe(2);
      expect(openPage.value.hasMore).toBe(true);
      expect(openPage.value.nextCursor).not.toBeNull();

      const secondOpenPage = await repo.listCampaignAdminThreads({
        campaignKey: 'funky',
        stateGroup: 'open',
        ...(openPage.value.nextCursor !== null ? { cursor: openPage.value.nextCursor } : {}),
        limit: 1,
      });
      expect(secondOpenPage.isOk()).toBe(true);
      if (secondOpenPage.isErr()) {
        return;
      }

      expect(secondOpenPage.value.items).toHaveLength(1);
      expect(secondOpenPage.value.items[0]?.id).toBe('10000000-0000-0000-0000-000000000001');
      expect(secondOpenPage.value.totalCount).toBe(2);

      const resolvedPage = await repo.listCampaignAdminThreads({
        campaignKey: 'funky',
        responseStatus: 'request_denied',
        limit: 10,
      });
      expect(resolvedPage.isOk()).toBe(true);
      if (resolvedPage.isErr()) {
        return;
      }

      expect(resolvedPage.value.items.map((thread) => thread.id)).toEqual([
        '10000000-0000-0000-0000-000000000003',
      ]);
      expect(projectCampaignAdminThread(resolvedPage.value.items[0]!)).toMatchObject({
        threadState: 'resolved',
        currentResponseStatus: 'request_denied',
      });
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('persists non-terminal adminWorkflow atomically on the real DB path and rejects stale writes', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);
    const repo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger: pinoLogger({ enabled: false }),
    });

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO institutionemailthreads (
            id,
            entity_cui,
            campaign_key,
            thread_key,
            phase,
            last_email_at,
            last_reply_at,
            next_action_at,
            closed_at,
            record,
            created_at,
            updated_at
          )
          VALUES (
            '20000000-0000-0000-0000-000000000001',
            '92000001',
            'funky',
            'mutate-thread-1',
            'awaiting_reply',
            '2026-04-10T10:00:00.000Z'::timestamptz,
            NULL,
            NULL,
            NULL,
            '{
              "version":1,
              "campaign":"funky",
              "campaignKey":"funky",
              "ownerUserId":"owner-a",
              "subject":"Mutable thread",
              "submissionPath":"platform_send",
              "institutionEmail":"mutable@scope.test",
              "ngoIdentity":"funky_citizens",
              "requesterOrganizationName":null,
              "budgetPublicationDate":null,
              "consentCapturedAt":null,
              "contestationDeadlineAt":null,
              "captureAddress":"contact@test",
              "correspondence":[],
              "latestReview":null,
              "metadata":{}
            }'::jsonb,
            '2026-04-10T10:00:00.000Z'::timestamptz,
            '2026-04-10T10:00:00.000Z'::timestamptz
          );
        `);
      });

      const appendResult = await appendCampaignAdminThreadResponse(
        { repo },
        {
          campaignKey: 'funky',
          threadId: '20000000-0000-0000-0000-000000000001',
          actorUserId: 'admin-user-1',
          expectedUpdatedAt: new Date('2026-04-10T10:00:00.000Z'),
          responseDate: new Date('2026-04-10T11:15:00.000Z'),
          messageContent: 'Registration number received.',
          responseStatus: 'registration_number_received',
        }
      );

      expect(appendResult.isOk()).toBe(true);
      if (appendResult.isErr()) {
        return;
      }

      expect(appendResult.value.createdResponseEventId).toBeTruthy();
      expect(projectCampaignAdminThread(appendResult.value.thread)).toMatchObject({
        threadState: 'pending',
        currentResponseStatus: 'registration_number_received',
      });
      expect(appendResult.value.thread.phase).toBe('awaiting_reply');

      const reloadedThread = await repo.findCampaignAdminThreadById({
        campaignKey: 'funky',
        threadId: '20000000-0000-0000-0000-000000000001',
      });
      expect(reloadedThread.isOk()).toBe(true);
      if (reloadedThread.isErr() || reloadedThread.value === null) {
        return;
      }

      expect(reloadedThread.value.record.adminWorkflow?.responseEvents).toEqual([
        expect.objectContaining({
          id: appendResult.value.createdResponseEventId,
          messageContent: 'Registration number received.',
          responseStatus: 'registration_number_received',
        }),
      ]);
      expect(reloadedThread.value.lastEmailAt?.toISOString()).toBe('2026-04-10T10:00:00.000Z');
      expect(reloadedThread.value.lastReplyAt?.toISOString()).toBe('2026-04-10T11:15:00.000Z');

      const staleResult = await appendCampaignAdminThreadResponse(
        { repo },
        {
          campaignKey: 'funky',
          threadId: '20000000-0000-0000-0000-000000000001',
          actorUserId: 'admin-user-1',
          expectedUpdatedAt: new Date('2026-04-10T10:00:00.000Z'),
          responseDate: new Date('2026-04-10T11:20:00.000Z'),
          messageContent: 'Stale retry',
          responseStatus: 'registration_number_received',
        }
      );

      expect(staleResult.isErr()).toBe(true);
      if (staleResult.isOk()) {
        return;
      }

      expect(staleResult.error.type).toBe(createConflictError('').type);
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('maps terminal admin responses to resolved compatibility state and removes them from recovery', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);
    const repo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger: pinoLogger({ enabled: false }),
    });
    const learningProgressRepo = makeLearningProgressRepo({
      db: userDb,
      logger: pinoLogger({ enabled: false }),
    });

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO userinteractions (
            user_id,
            record_key,
            record,
            audit_events,
            updated_seq,
            created_at,
            updated_at
          )
          VALUES (
            'user-terminal-thread',
            'funky:interaction:public_debate_request::entity:92500001',
            '{
              "key":"funky:interaction:public_debate_request::entity:92500001",
              "interactionId":"funky:interaction:public_debate_request",
              "lessonId":"civic-monitor-and-request",
              "kind":"custom",
              "scope":{"type":"entity","entityCui":"92500001"},
              "completionRule":{"type":"resolved"},
              "phase":"pending",
              "value":{
                "kind":"json",
                "json":{
                  "value":{
                    "primariaEmail":"terminal@scope.test",
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
            1,
            '2026-04-10T10:00:00.000Z',
            '2026-04-10T10:00:00.000Z'
          );
        `);

        await client.query(`
          INSERT INTO institutionemailthreads (
            id,
            entity_cui,
            campaign_key,
            thread_key,
            phase,
            last_email_at,
            last_reply_at,
            next_action_at,
            closed_at,
            record,
            created_at,
            updated_at
          )
          VALUES (
            '25000000-0000-0000-0000-000000000001',
            '92500001',
            'funky',
            'mutate-thread-2',
            'awaiting_reply',
            '2026-04-10T10:00:00.000Z'::timestamptz,
            NULL,
            NULL,
            NULL,
            '{
              "version":1,
              "campaign":"funky",
              "campaignKey":"funky",
              "ownerUserId":"owner-b",
              "subject":"Terminal mutable thread",
              "submissionPath":"platform_send",
              "institutionEmail":"terminal@scope.test",
              "ngoIdentity":"funky_citizens",
              "requesterOrganizationName":null,
              "budgetPublicationDate":null,
              "consentCapturedAt":null,
              "contestationDeadlineAt":null,
              "captureAddress":"contact@test",
              "correspondence":[],
              "latestReview":null,
              "metadata":{}
            }'::jsonb,
            '2026-04-10T10:00:00.000Z'::timestamptz,
            '2026-04-10T10:00:00.000Z'::timestamptz
          );
        `);
      });

      const appendResult = await appendCampaignAdminThreadResponse(
        { repo },
        {
          campaignKey: 'funky',
          threadId: '25000000-0000-0000-0000-000000000001',
          actorUserId: 'admin-user-2',
          expectedUpdatedAt: new Date('2026-04-10T10:00:00.000Z'),
          responseDate: new Date('2026-04-10T11:15:00.000Z'),
          messageContent: 'Request confirmed.',
          responseStatus: 'request_confirmed',
        }
      );

      expect(appendResult.isOk()).toBe(true);
      if (appendResult.isErr()) {
        return;
      }

      expect(appendResult.value.thread.phase).toBe('resolved_positive');
      expect(appendResult.value.thread.lastEmailAt?.toISOString()).toBe('2026-04-10T10:00:00.000Z');
      expect(appendResult.value.thread.lastReplyAt?.toISOString()).toBe('2026-04-10T11:15:00.000Z');
      expect(appendResult.value.thread.nextActionAt).toBeNull();
      expect(appendResult.value.thread.closedAt?.toISOString()).toBe('2026-04-10T11:15:00.000Z');
      expect(projectCampaignAdminThread(appendResult.value.thread)).toMatchObject({
        threadState: 'resolved',
        currentResponseStatus: 'request_confirmed',
      });

      const reloadedThread = await repo.findCampaignAdminThreadById({
        campaignKey: 'funky',
        threadId: '25000000-0000-0000-0000-000000000001',
      });
      expect(reloadedThread.isOk()).toBe(true);
      if (reloadedThread.isErr() || reloadedThread.value === null) {
        return;
      }

      expect(reloadedThread.value.phase).toBe('resolved_positive');
      expect(reloadedThread.value.closedAt?.toISOString()).toBe('2026-04-10T11:15:00.000Z');

      const resolvedRowsResult = await learningProgressRepo.listCampaignAdminInteractionRows({
        campaignKey: 'funky',
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
        ],
        hasInstitutionThread: true,
        threadPhase: 'resolved_positive',
        limit: 10,
      });
      expect(resolvedRowsResult.isOk()).toBe(true);
      if (resolvedRowsResult.isErr()) {
        return;
      }

      expect(resolvedRowsResult.value.rows).toHaveLength(1);
      expect(resolvedRowsResult.value.rows[0]?.threadSummary).toEqual({
        threadId: '25000000-0000-0000-0000-000000000001',
        threadPhase: 'resolved_positive',
        lastEmailAt: '2026-04-10T10:00:00.000Z',
        lastReplyAt: '2026-04-10T11:15:00.000Z',
        nextActionAt: null,
      });

      const openRowsResult = await learningProgressRepo.listCampaignAdminInteractionRows({
        campaignKey: 'funky',
        interactions: [
          {
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          },
        ],
        hasInstitutionThread: true,
        threadPhase: 'awaiting_reply',
        limit: 10,
      });
      expect(openRowsResult.isOk()).toBe(true);
      if (openRowsResult.isErr()) {
        return;
      }

      expect(openRowsResult.value.rows).toEqual([]);

      const pendingSuccessThreads = await repo.listPlatformSendThreadsPendingSuccessConfirmation(0);
      expect(pendingSuccessThreads.isOk()).toBe(true);
      if (pendingSuccessThreads.isErr()) {
        return;
      }

      expect(pendingSuccessThreads.value.map((thread) => thread.id)).not.toContain(
        '25000000-0000-0000-0000-000000000001'
      );
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('keeps legacy rows with null campaign_key readable and writable through campaign-admin scope', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);
    const repo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger: pinoLogger({ enabled: false }),
    });

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO institutionemailthreads (
            id,
            entity_cui,
            campaign_key,
            thread_key,
            phase,
            last_email_at,
            last_reply_at,
            next_action_at,
            closed_at,
            record,
            created_at,
            updated_at
          )
          VALUES (
            '30000000-0000-0000-0000-000000000001',
            '93000001',
            NULL,
            'legacy-scope-thread-1',
            'awaiting_reply',
            '2026-04-11T09:00:00.000Z'::timestamptz,
            NULL,
            NULL,
            NULL,
            '{
              "version":1,
              "campaign":"funky",
              "campaignKey":null,
              "ownerUserId":"owner-legacy",
              "subject":"Legacy scoped thread",
              "submissionPath":"platform_send",
              "institutionEmail":"legacy@scope.test",
              "ngoIdentity":"funky_citizens",
              "requesterOrganizationName":null,
              "budgetPublicationDate":null,
              "consentCapturedAt":null,
              "contestationDeadlineAt":null,
              "captureAddress":"contact@test",
              "correspondence":[],
              "latestReview":null,
              "metadata":{}
            }'::jsonb,
            '2026-04-11T09:00:00.000Z'::timestamptz,
            '2026-04-11T09:00:00.000Z'::timestamptz
          );
        `);
      });

      const foundResult = await repo.findCampaignAdminThreadById({
        campaignKey: 'funky',
        threadId: '30000000-0000-0000-0000-000000000001',
      });

      expect(foundResult.isOk()).toBe(true);
      if (foundResult.isErr() || foundResult.value === null) {
        return;
      }

      expect(foundResult.value.campaignKey).toBe('funky');

      const appendResult = await appendCampaignAdminThreadResponse(
        { repo },
        {
          campaignKey: 'funky',
          threadId: '30000000-0000-0000-0000-000000000001',
          actorUserId: 'admin-user-legacy',
          expectedUpdatedAt: new Date('2026-04-11T09:00:00.000Z'),
          responseDate: new Date('2026-04-11T10:00:00.000Z'),
          messageContent: 'Registration number received on the legacy row.',
          responseStatus: 'registration_number_received',
        }
      );

      expect(appendResult.isOk()).toBe(true);
      if (appendResult.isErr()) {
        return;
      }

      expect(appendResult.value.thread.phase).toBe('awaiting_reply');
      expect(projectCampaignAdminThread(appendResult.value.thread)).toMatchObject({
        threadState: 'pending',
        currentResponseStatus: 'registration_number_received',
      });

      const listResult = await repo.listCampaignAdminThreads({
        campaignKey: 'funky',
        threadState: 'pending',
        limit: 10,
      });

      expect(listResult.isOk()).toBe(true);
      if (listResult.isErr()) {
        return;
      }

      expect(listResult.value.items.map((thread) => thread.id)).toContain(
        '30000000-0000-0000-0000-000000000001'
      );

      const reloadedThread = await repo.findCampaignAdminThreadById({
        campaignKey: 'funky',
        threadId: '30000000-0000-0000-0000-000000000001',
      });

      expect(reloadedThread.isOk()).toBe(true);
      if (reloadedThread.isErr() || reloadedThread.value === null) {
        return;
      }

      expect(reloadedThread.value.record.adminWorkflow?.responseEvents).toEqual([
        expect.objectContaining({
          id: appendResult.value.createdResponseEventId,
          responseStatus: 'registration_number_received',
        }),
      ]);
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('keeps sending threads out of campaign-admin scope on the real repo path', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);
    const repo = makeInstitutionCorrespondenceRepo({
      db: userDb,
      logger: pinoLogger({ enabled: false }),
    });

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO institutionemailthreads (
            id,
            entity_cui,
            campaign_key,
            thread_key,
            phase,
            last_email_at,
            last_reply_at,
            next_action_at,
            closed_at,
            record,
            created_at,
            updated_at
          )
          VALUES (
            '35000000-0000-0000-0000-000000000001',
            '93500001',
            'funky',
            'sending-thread-1',
            'sending',
            NULL,
            NULL,
            NULL,
            NULL,
            '{
              "version":1,
              "campaign":"funky",
              "campaignKey":"funky",
              "ownerUserId":"owner-sending",
              "subject":"Sending thread",
              "submissionPath":"platform_send",
              "institutionEmail":"sending@scope.test",
              "ngoIdentity":"funky_citizens",
              "requesterOrganizationName":null,
              "budgetPublicationDate":null,
              "consentCapturedAt":null,
              "contestationDeadlineAt":null,
              "captureAddress":"contact@test",
              "correspondence":[],
              "latestReview":null,
              "metadata":{}
            }'::jsonb,
            '2026-04-11T09:00:00.000Z'::timestamptz,
            '2026-04-11T09:00:00.000Z'::timestamptz
          );
        `);
      });

      const foundResult = await repo.findCampaignAdminThreadById({
        campaignKey: 'funky',
        threadId: '35000000-0000-0000-0000-000000000001',
      });

      expect(foundResult.isOk()).toBe(true);
      if (foundResult.isErr()) {
        return;
      }

      expect(foundResult.value).toBeNull();

      const listResult = await repo.listCampaignAdminThreads({
        campaignKey: 'funky',
        limit: 10,
      });

      expect(listResult.isOk()).toBe(true);
      if (listResult.isErr()) {
        return;
      }

      expect(listResult.value.items.map((thread) => thread.id)).not.toContain(
        '35000000-0000-0000-0000-000000000001'
      );

      const appendResult = await appendCampaignAdminThreadResponse(
        { repo },
        {
          campaignKey: 'funky',
          threadId: '35000000-0000-0000-0000-000000000001',
          actorUserId: 'admin-user-sending',
          expectedUpdatedAt: new Date('2026-04-11T09:00:00.000Z'),
          responseDate: new Date('2026-04-11T10:00:00.000Z'),
          messageContent: 'Should stay out of scope.',
          responseStatus: 'registration_number_received',
        }
      );

      expect(appendResult.isErr()).toBe(true);
      if (appendResult.isOk()) {
        return;
      }

      expect(appendResult.error.type).toBe('CorrespondenceNotFoundError');
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });
});
