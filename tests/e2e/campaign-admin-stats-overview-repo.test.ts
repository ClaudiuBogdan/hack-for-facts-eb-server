import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  CITY_HALL_WEBSITE_INTERACTION_ID,
  CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS,
  DEBATE_REQUEST_INTERACTION_ID,
} from '@/common/campaign-user-interactions.js';
import { makeCampaignAdminStatsReader } from '@/modules/campaign-admin-stats/index.js';

import { dockerAvailable } from './setup.js';
import { makeFakeLearningProgressRepo } from '../fixtures/fakes.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
import type { CampaignAdminEntitiesRepository } from '@/modules/campaign-admin-entities/index.js';
import type { EntityRepository } from '@/modules/entity/index.js';

const { Pool } = pg;

const USER_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
  'utf-8'
);

interface StartedTestDatabase {
  readonly connectionString: string;
  readonly stop: () => Promise<void>;
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

function makeEntitiesRepository(): CampaignAdminEntitiesRepository {
  return {
    async listCampaignAdminEntities() {
      throw new Error('listCampaignAdminEntities should not be called in this test');
    },
    async getCampaignAdminEntitiesMetaCounts() {
      return ok({
        totalEntities: 4,
        entitiesWithPendingReviews: 1,
        entitiesWithSubscribers: 2,
        entitiesWithNotificationActivity: 3,
        entitiesWithFailedNotifications: 1,
      });
    },
  };
}

function makeEntityRepo(nameByCui: Record<string, string>): EntityRepository {
  return {
    getById: vi.fn(async (cui: string) =>
      ok(
        nameByCui[cui] === undefined
          ? null
          : ({
              cui,
              name: nameByCui[cui],
            } as never)
      )
    ),
    getByIds: vi.fn(async (cuis: string[]) =>
      ok(
        new Map(
          cuis.flatMap((cui) =>
            nameByCui[cui] === undefined
              ? []
              : [[cui, { cui, name: nameByCui[cui] } as never] as const]
          )
        )
      )
    ),
    getAll: vi.fn(),
    getChildren: vi.fn(),
    getParents: vi.fn(),
    getCountyEntity: vi.fn(),
  };
}

describe('Campaign admin stats repo', () => {
  it('aggregates safe notification engagement counts by outbox delivery', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const userDb = createKyselyClient<UserDatabase>(database.connectionString);
    const learningProgressRepo = makeFakeLearningProgressRepo();

    vi.spyOn(learningProgressRepo, 'getCampaignAdminUsersMetaCounts').mockResolvedValue(
      ok({
        totalUsers: 9,
        usersWithPendingReviews: 2,
      })
    );
    vi.spyOn(learningProgressRepo, 'getCampaignAdminStats').mockResolvedValue(
      ok({
        stats: {
          total: 11,
          withInstitutionThread: 3,
          reviewStatusCounts: {
            pending: 2,
            approved: 5,
            rejected: 1,
            notReviewed: 3,
          },
          phaseCounts: {
            idle: 0,
            draft: 1,
            pending: 2,
            resolved: 6,
            failed: 2,
          },
          threadPhaseCounts: {
            sending: 0,
            awaiting_reply: 1,
            reply_received_unreviewed: 1,
            manual_follow_up_needed: 0,
            resolved_positive: 0,
            resolved_negative: 0,
            closed_no_response: 0,
            failed: 1,
            none: 8,
          },
        },
        riskFlagCandidates: [],
      })
    );

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);

        await client.query(`
          INSERT INTO notificationsoutbox (
            id,
            user_id,
            notification_type,
            scope_key,
            delivery_key,
            status,
            resend_email_id,
            to_email,
            rendered_subject,
            rendered_html,
            rendered_text,
            metadata,
            created_at,
            sent_at
          )
          VALUES
            (
              '00000000-0000-0000-0000-000000000101',
              'user-1',
              'funky:outbox:welcome',
              'scope-1',
              'delivery-1',
              'delivered',
              'email-1',
              'user-1@example.com',
              'Sensitive welcome subject',
              '<p>Sensitive welcome html</p>',
              'Sensitive welcome text',
              '{"campaignKey":"funky"}'::jsonb,
              '2026-04-10T10:00:00.000Z',
              '2026-04-10T10:01:00.000Z'
            ),
            (
              '00000000-0000-0000-0000-000000000102',
              'user-2',
              'funky:outbox:entity_update',
              'scope-2',
              'delivery-2',
              'delivered',
              'email-2',
              'user-2@example.com',
              'Sensitive update subject',
              '<p>Sensitive update html</p>',
              'Sensitive update text',
              '{"campaignKey":"funky"}'::jsonb,
              '2026-04-10T11:00:00.000Z',
              '2026-04-10T11:01:00.000Z'
            ),
            (
              '00000000-0000-0000-0000-000000000103',
              'user-3',
              'funky:outbox:entity_subscription',
              'scope-3',
              'delivery-3',
              'pending',
              NULL,
              'user-3@example.com',
              'Pending subject',
              '<p>Pending html</p>',
              'Pending text',
              '{"campaignKey":"funky"}'::jsonb,
              '2026-04-10T12:00:00.000Z',
              NULL
            ),
            (
              '00000000-0000-0000-0000-000000000104',
              'user-4',
              'funky:outbox:admin_failure',
              'scope-4',
              'delivery-4',
              'failed_permanent',
              'email-4',
              'user-4@example.com',
              'Failure subject',
              '<p>Failure html</p>',
              'Failure text',
              '{"campaignKey":"funky"}'::jsonb,
              '2026-04-10T13:00:00.000Z',
              '2026-04-10T13:01:00.000Z'
            ),
            (
              '00000000-0000-0000-0000-000000000105',
              'user-5',
              'funky:outbox:admin_reviewed_interaction',
              'scope-5',
              'delivery-5',
              'suppressed',
              'email-5',
              'user-5@example.com',
              'Suppressed subject',
              '<p>Suppressed html</p>',
              'Suppressed text',
              '{"campaignKey":"funky"}'::jsonb,
              '2026-04-10T14:00:00.000Z',
              '2026-04-10T14:01:00.000Z'
            ),
            (
              '00000000-0000-0000-0000-000000000106',
              'user-6',
              'funky:outbox:welcome',
              'scope-6',
              'delivery-6',
              'delivered',
              'email-6',
              'user-6@example.com',
              'Other campaign subject',
              '<p>Other campaign html</p>',
              'Other campaign text',
              '{"campaignKey":"other"}'::jsonb,
              '2026-04-10T15:00:00.000Z',
              '2026-04-10T15:01:00.000Z'
            )
        `);

        await client.query(`
          INSERT INTO resend_wh_emails (
            svix_id,
            event_type,
            event_created_at,
            email_id,
            from_address,
            to_addresses,
            subject,
            email_created_at,
            click_link
          )
          VALUES
            (
              'svix-101',
              'email.opened',
              '2026-04-10T10:02:00.000Z',
              'email-1',
              'noreply@transparenta.eu',
              ARRAY['user-1@example.com']::text[],
              'Sensitive welcome subject',
              '2026-04-10T10:00:00.000Z',
              NULL
            ),
            (
              'svix-102',
              'email.opened',
              '2026-04-10T11:02:00.000Z',
              'email-2',
              'noreply@transparenta.eu',
              ARRAY['user-2@example.com']::text[],
              'Sensitive update subject',
              '2026-04-10T11:00:00.000Z',
              NULL
            ),
            (
              'svix-103',
              'email.clicked',
              '2026-04-10T11:03:00.000Z',
              'email-2',
              'noreply@transparenta.eu',
              ARRAY['user-2@example.com']::text[],
              'Sensitive update subject',
              '2026-04-10T11:00:00.000Z',
              'https://example.invalid/private-click'
            ),
            (
              'svix-104',
              'email.clicked',
              '2026-04-10T11:04:00.000Z',
              'email-2',
              'noreply@transparenta.eu',
              ARRAY['user-2@example.com']::text[],
              'Sensitive update subject',
              '2026-04-10T11:00:00.000Z',
              'https://example.invalid/private-click-2'
            ),
            (
              'svix-105',
              'email.delivered',
              '2026-04-10T14:02:00.000Z',
              'email-5',
              'noreply@transparenta.eu',
              ARRAY['user-5@example.com']::text[],
              'Suppressed subject',
              '2026-04-10T14:00:00.000Z',
              NULL
            ),
            (
              'svix-106',
              'email.opened',
              '2026-04-10T15:02:00.000Z',
              'email-6',
              'noreply@transparenta.eu',
              ARRAY['user-6@example.com']::text[],
              'Other campaign subject',
              '2026-04-10T15:00:00.000Z',
              NULL
            )
        `);
      });

      const reader = makeCampaignAdminStatsReader({
        userDb,
        learningProgressRepo,
        entitiesRepository: makeEntitiesRepository(),
        entityRepo: makeEntityRepo({}),
        logger: pinoLogger({ level: 'silent' }),
      });
      const result = await reader.getOverview({
        campaignKey: 'funky',
      });

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }

      expect(result.value.coverage).toEqual({
        hasClientTelemetry: false,
        hasNotificationAttribution: true,
      });
      expect(result.value.users).toEqual({
        totalUsers: 9,
        usersWithPendingReviews: 2,
      });
      expect(result.value.entities).toEqual({
        totalEntities: 4,
        entitiesWithPendingReviews: 1,
        entitiesWithSubscribers: 2,
        entitiesWithNotificationActivity: 3,
        entitiesWithFailedNotifications: 1,
      });
      expect(result.value.notifications).toEqual({
        pendingDeliveryCount: 1,
        failedDeliveryCount: 1,
        deliveredCount: 3,
        openedCount: 2,
        clickedCount: 1,
        suppressedCount: 1,
      });
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('returns ranked interaction aggregates by type', async () => {
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
              'row-1',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'resolved',
                review: { status: 'approved' },
                scope: { type: 'entity', entityCui: '11111111' },
              })}'::jsonb,
              '[]'::jsonb,
              1,
              '2026-04-10T10:00:00.000Z',
              '2026-04-10T10:00:00.000Z'
            ),
            (
              'user-2',
              'row-2',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'pending',
                scope: { type: 'entity', entityCui: '22222222' },
              })}'::jsonb,
              '[]'::jsonb,
              2,
              '2026-04-10T11:00:00.000Z',
              '2026-04-10T11:00:00.000Z'
            ),
            (
              'user-3',
              'row-3',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'resolved',
                scope: { type: 'entity', entityCui: '33333333' },
              })}'::jsonb,
              '[]'::jsonb,
              3,
              '2026-04-10T12:00:00.000Z',
              '2026-04-10T12:00:00.000Z'
            ),
            (
              'user-4',
              'row-4',
              '${JSON.stringify({
                interactionId: DEBATE_REQUEST_INTERACTION_ID,
                phase: 'resolved',
                review: { status: 'approved' },
                value: { kind: 'json', json: { value: { submissionPath: 'request_platform' } } },
                scope: { type: 'entity', entityCui: '11111111' },
              })}'::jsonb,
              '[]'::jsonb,
              4,
              '2026-04-10T13:00:00.000Z',
              '2026-04-10T13:00:00.000Z'
            ),
            (
              'user-5',
              'row-5',
              '${JSON.stringify({
                interactionId: DEBATE_REQUEST_INTERACTION_ID,
                phase: 'failed',
                review: { status: 'rejected' },
                value: { kind: 'json', json: { value: { submissionPath: 'request_platform' } } },
                scope: { type: 'entity', entityCui: '22222222' },
              })}'::jsonb,
              '[]'::jsonb,
              5,
              '2026-04-10T14:00:00.000Z',
              '2026-04-10T14:00:00.000Z'
            ),
            (
              'user-6',
              'row-6',
              '${JSON.stringify({
                interactionId: DEBATE_REQUEST_INTERACTION_ID,
                phase: 'pending',
                value: { kind: 'json', json: { value: { submissionPath: 'request_platform' } } },
                scope: { type: 'entity', entityCui: '33333333' },
              })}'::jsonb,
              '[]'::jsonb,
              6,
              '2026-04-10T15:00:00.000Z',
              '2026-04-10T15:00:00.000Z'
            ),
            (
              'user-7',
              'row-7',
              '${JSON.stringify({
                interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[0],
                phase: 'resolved',
                scope: { type: 'global' },
              })}'::jsonb,
              '[]'::jsonb,
              7,
              '2026-04-10T16:00:00.000Z',
              '2026-04-10T16:00:00.000Z'
            )
        `);
      });

      const reader = makeCampaignAdminStatsReader({
        userDb,
        learningProgressRepo: makeFakeLearningProgressRepo(),
        entitiesRepository: makeEntitiesRepository(),
        entityRepo: makeEntityRepo({}),
        logger: pinoLogger({ level: 'silent' }),
      });
      const result = await reader.getInteractionsByType({
        campaignKey: 'funky',
      });

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }

      expect(result.value).toEqual({
        items: [
          {
            interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
            label: 'City hall website',
            total: 3,
            pending: 1,
            approved: 1,
            rejected: 0,
            notReviewed: 1,
          },
          {
            interactionId: DEBATE_REQUEST_INTERACTION_ID,
            label: 'Public debate request',
            total: 3,
            pending: 1,
            approved: 1,
            rejected: 1,
            notReviewed: 0,
          },
          {
            interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[0],
            label: 'Quiz: Module structure',
            total: 1,
            pending: 0,
            approved: 0,
            rejected: 0,
            notReviewed: 1,
          },
        ],
      });
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });

  it('returns top entities ranked by the requested metric', async () => {
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
              'entity-111-row-1',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'resolved',
                review: { status: 'approved' },
                scope: { type: 'entity', entityCui: '11111111' },
              })}'::jsonb,
              '[]'::jsonb,
              1,
              '2026-04-10T10:00:00.000Z',
              '2026-04-10T10:00:00.000Z'
            ),
            (
              'user-1',
              'entity-111-row-2',
              '${JSON.stringify({
                interactionId: DEBATE_REQUEST_INTERACTION_ID,
                phase: 'resolved',
                review: { status: 'approved' },
                value: { kind: 'json', json: { value: { submissionPath: 'request_platform' } } },
                scope: { type: 'entity', entityCui: '11111111' },
              })}'::jsonb,
              '[]'::jsonb,
              2,
              '2026-04-10T10:10:00.000Z',
              '2026-04-10T10:10:00.000Z'
            ),
            (
              'user-2',
              'entity-111-row-3',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'pending',
                scope: { type: 'entity', entityCui: '11111111' },
              })}'::jsonb,
              '[]'::jsonb,
              3,
              '2026-04-10T10:20:00.000Z',
              '2026-04-10T10:20:00.000Z'
            ),
            (
              'user-3',
              'entity-222-row-1',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'resolved',
                review: { status: 'approved' },
                scope: { type: 'entity', entityCui: '22222222' },
              })}'::jsonb,
              '[]'::jsonb,
              4,
              '2026-04-10T11:00:00.000Z',
              '2026-04-10T11:00:00.000Z'
            ),
            (
              'user-4',
              'entity-222-row-2',
              '${JSON.stringify({
                interactionId: DEBATE_REQUEST_INTERACTION_ID,
                phase: 'resolved',
                review: { status: 'approved' },
                value: { kind: 'json', json: { value: { submissionPath: 'request_platform' } } },
                scope: { type: 'entity', entityCui: '22222222' },
              })}'::jsonb,
              '[]'::jsonb,
              5,
              '2026-04-10T11:10:00.000Z',
              '2026-04-10T11:10:00.000Z'
            ),
            (
              'user-5',
              'entity-222-row-3',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'failed',
                review: { status: 'rejected' },
                scope: { type: 'entity', entityCui: '22222222' },
              })}'::jsonb,
              '[]'::jsonb,
              6,
              '2026-04-10T11:20:00.000Z',
              '2026-04-10T11:20:00.000Z'
            ),
            (
              'user-6',
              'entity-222-row-4',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'pending',
                scope: { type: 'entity', entityCui: '22222222' },
              })}'::jsonb,
              '[]'::jsonb,
              7,
              '2026-04-10T11:30:00.000Z',
              '2026-04-10T11:30:00.000Z'
            ),
            (
              'user-7',
              'entity-333-row-1',
              '${JSON.stringify({
                interactionId: CITY_HALL_WEBSITE_INTERACTION_ID,
                phase: 'pending',
                scope: { type: 'entity', entityCui: '33333333' },
              })}'::jsonb,
              '[]'::jsonb,
              8,
              '2026-04-10T12:00:00.000Z',
              '2026-04-10T12:00:00.000Z'
            ),
            (
              'user-8',
              'entity-333-row-2',
              '${JSON.stringify({
                interactionId: DEBATE_REQUEST_INTERACTION_ID,
                phase: 'pending',
                value: { kind: 'json', json: { value: { submissionPath: 'request_platform' } } },
                scope: { type: 'entity', entityCui: '33333333' },
              })}'::jsonb,
              '[]'::jsonb,
              9,
              '2026-04-10T12:10:00.000Z',
              '2026-04-10T12:10:00.000Z'
            )
        `);

        await client.query(`
          INSERT INTO notifications (id, user_id, entity_cui, notification_type, is_active, config, hash)
          VALUES
            (
              '00000000-0000-0000-0000-000000000301',
              'user-9',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-global-user-9'
            ),
            (
              '00000000-0000-0000-0000-000000000302',
              'user-9',
              '11111111',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-entity-user-9'
            ),
            (
              '00000000-0000-0000-0000-000000000303',
              'user-10',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-global-user-10'
            ),
            (
              '00000000-0000-0000-0000-000000000304',
              'user-10',
              '33333333',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-entity-user-10'
            ),
            (
              '00000000-0000-0000-0000-000000000305',
              'user-11',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-global-user-11'
            ),
            (
              '00000000-0000-0000-0000-000000000306',
              'user-11',
              '44444444',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-entity-user-11'
            ),
            (
              '00000000-0000-0000-0000-000000000307',
              'user-12',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-global-user-12'
            ),
            (
              '00000000-0000-0000-0000-000000000308',
              'user-12',
              '11111111',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-entity-user-12'
            ),
            (
              '00000000-0000-0000-0000-000000000309',
              'user-12',
              NULL,
              'global_unsubscribe',
              FALSE,
              '{"channels":{"email":false}}'::jsonb,
              'hash-unsubscribe-user-12'
            )
        `);
      });

      const reader = makeCampaignAdminStatsReader({
        userDb,
        learningProgressRepo: makeFakeLearningProgressRepo(),
        entitiesRepository: makeEntitiesRepository(),
        entityRepo: makeEntityRepo({
          '11111111': 'Entity One',
          '22222222': 'Entity Two',
          '33333333': '   ',
          '44444444': 'Entity Four',
        }),
        logger: pinoLogger({ level: 'silent' }),
      });

      const byInteractionCount = await reader.getTopEntities({
        campaignKey: 'funky',
        sortBy: 'interactionCount',
        limit: 2,
      });
      const byUserCount = await reader.getTopEntities({
        campaignKey: 'funky',
        sortBy: 'userCount',
        limit: 4,
      });
      const byPendingReviewCount = await reader.getTopEntities({
        campaignKey: 'funky',
        sortBy: 'pendingReviewCount',
        limit: 3,
      });

      expect(byInteractionCount.isOk()).toBe(true);
      expect(byUserCount.isOk()).toBe(true);
      expect(byPendingReviewCount.isOk()).toBe(true);
      if (byInteractionCount.isErr() || byUserCount.isErr() || byPendingReviewCount.isErr()) {
        return;
      }

      expect(byInteractionCount.value).toEqual({
        sortBy: 'interactionCount',
        limit: 2,
        items: [
          {
            entityCui: '22222222',
            entityName: 'Entity Two',
            interactionCount: 4,
            userCount: 4,
            pendingReviewCount: 1,
          },
          {
            entityCui: '11111111',
            entityName: 'Entity One',
            interactionCount: 3,
            userCount: 3,
            pendingReviewCount: 1,
          },
        ],
      });

      expect(byUserCount.value).toEqual({
        sortBy: 'userCount',
        limit: 4,
        items: [
          {
            entityCui: '22222222',
            entityName: 'Entity Two',
            interactionCount: 4,
            userCount: 4,
            pendingReviewCount: 1,
          },
          {
            entityCui: '11111111',
            entityName: 'Entity One',
            interactionCount: 3,
            userCount: 3,
            pendingReviewCount: 1,
          },
          {
            entityCui: '33333333',
            entityName: null,
            interactionCount: 2,
            userCount: 3,
            pendingReviewCount: 2,
          },
          {
            entityCui: '44444444',
            entityName: 'Entity Four',
            interactionCount: 0,
            userCount: 1,
            pendingReviewCount: 0,
          },
        ],
      });

      expect(byPendingReviewCount.value).toEqual({
        sortBy: 'pendingReviewCount',
        limit: 3,
        items: [
          {
            entityCui: '33333333',
            entityName: null,
            interactionCount: 2,
            userCount: 3,
            pendingReviewCount: 2,
          },
          {
            entityCui: '11111111',
            entityName: 'Entity One',
            interactionCount: 3,
            userCount: 3,
            pendingReviewCount: 1,
          },
          {
            entityCui: '22222222',
            entityName: 'Entity Two',
            interactionCount: 4,
            userCount: 4,
            pendingReviewCount: 1,
          },
        ],
      });
    } finally {
      await userDb.destroy();
      await database.stop();
    }
  });
});
