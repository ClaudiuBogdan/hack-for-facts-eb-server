import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { makeCampaignAdminStatsReader } from '@/modules/campaign-admin-stats/index.js';

import { dockerAvailable } from './setup.js';
import { makeFakeLearningProgressRepo } from '../fixtures/fakes.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
import type { CampaignAdminEntitiesRepository } from '@/modules/campaign-admin-entities/index.js';

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

describe('Campaign admin stats overview repo', () => {
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
});
