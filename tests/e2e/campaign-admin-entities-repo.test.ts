import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import createPinoLogger from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import {
  makeCampaignAdminEntitiesRepo,
  type CampaignAdminEntityListCursor as CampaignAdminEntityCursor,
  type CampaignAdminEntitySortBy,
  type CampaignAdminEntitySortOrder,
} from '@/modules/campaign-admin-entities/index.js';

import { dockerAvailable } from './setup.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
import type { EntityRepository } from '@/modules/entity/index.js';

const { Pool } = pg;

const USER_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
  'utf-8'
);

const DEFAULT_INTERACTIONS = [
  { interactionId: 'funky:interaction:public_debate_request' },
  { interactionId: 'funky:interaction:city_hall_website' },
  { interactionId: 'funky:interaction:funky_participation' },
] as const;

const DEFAULT_REVIEWABLE_INTERACTIONS = [
  {
    interactionId: 'funky:interaction:public_debate_request',
    submissionPath: 'request_platform',
  },
  {
    interactionId: 'funky:interaction:city_hall_website',
  },
] as const;

const ENTITY_NAMES: Record<string, string> = {
  '11111111': 'Municipiul Exemplu',
  '22222222': 'Comuna Doi',
  '33333333': 'Orasul Trei',
  '44444444': 'Comuna Patru',
  '55555555': 'Municipiul Cinci',
};

function makeEntityRepoStub(entityNames: Record<string, string>): EntityRepository {
  return {
    async getById(cui) {
      const name = entityNames[cui];
      return ok(
        name === undefined
          ? null
          : {
              cui,
              name,
              entity_type: null,
              default_report_type: 'Executie bugetara detaliata',
              uat_id: null,
              is_uat: true,
              address: null,
              last_updated: null,
              main_creditor_1_cui: null,
              main_creditor_2_cui: null,
            }
      );
    },
    async getByIds(cuis) {
      return ok(
        new Map(
          cuis.flatMap((cui) => {
            const name = entityNames[cui];
            return name === undefined
              ? []
              : [
                  [
                    cui,
                    {
                      cui,
                      name,
                      entity_type: null,
                      default_report_type: 'Executie bugetara detaliata',
                      uat_id: null,
                      is_uat: true,
                      address: null,
                      last_updated: null,
                      main_creditor_1_cui: null,
                      main_creditor_2_cui: null,
                    },
                  ] as const,
                ];
          })
        )
      );
    },
    async getAll() {
      return ok({
        nodes: [],
        pageInfo: {
          totalCount: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
    },
    async getChildren() {
      return ok([]);
    },
    async getParents() {
      return ok([]);
    },
    async getCountyEntity() {
      return ok(null);
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

async function seedCampaignAdminEntitiesFixture(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO userinteractions (user_id, record_key, record, audit_events, updated_seq, created_at, updated_at)
    VALUES
      (
        'user-a',
        'funky:interaction:public_debate_request::entity:11111111::request-platform',
        '{
          "key":"funky:interaction:public_debate_request::entity:11111111::request-platform",
          "interactionId":"funky:interaction:public_debate_request",
          "lessonId":"civic-monitor-and-request",
          "kind":"custom",
          "scope":{"type":"entity","entityCui":"11111111"},
          "completionRule":{"type":"resolved"},
          "phase":"pending",
          "value":{
            "kind":"json",
            "json":{"value":{"submissionPath":"request_platform","submittedAt":"2026-04-10T10:00:00.000Z"}}
          },
          "result":null,
          "updatedAt":"2026-04-10T10:00:00.000Z",
          "submittedAt":"2026-04-10T10:00:00.000Z"
        }'::jsonb,
        '[]'::jsonb,
        1,
        '2026-04-10T10:00:00.000Z',
        '2026-04-10T10:00:00.000Z'
      ),
      (
        'user-a',
        'funky:interaction:city_hall_website::entity:11111111',
        '{
          "key":"funky:interaction:city_hall_website::entity:11111111",
          "interactionId":"funky:interaction:city_hall_website",
          "lessonId":"civic-monitor-and-request",
          "kind":"custom",
          "scope":{"type":"entity","entityCui":"11111111"},
          "completionRule":{"type":"resolved"},
          "phase":"resolved",
          "value":{
            "kind":"json",
            "json":{"value":{"websiteUrl":"https://11111111.example","submittedAt":"2026-04-10T12:00:00.000Z"}}
          },
          "result":null,
          "review":{"status":"approved","reviewedAt":"2026-04-10T12:00:00.000Z"},
          "updatedAt":"2026-04-10T12:00:00.000Z",
          "submittedAt":"2026-04-10T12:00:00.000Z"
        }'::jsonb,
        '[]'::jsonb,
        2,
        '2026-04-10T12:00:00.000Z',
        '2026-04-10T12:00:00.000Z'
      ),
      (
        'user-b',
        'funky:interaction:funky_participation::entity:11111111',
        '{
          "key":"funky:interaction:funky_participation::entity:11111111",
          "interactionId":"funky:interaction:funky_participation",
          "lessonId":"civic-participate-and-act",
          "kind":"custom",
          "scope":{"type":"entity","entityCui":"11111111"},
          "completionRule":{"type":"resolved"},
          "phase":"resolved",
          "value":{
            "kind":"json",
            "json":{"value":{"debateTookPlace":"yes","submittedAt":"2026-04-11T09:00:00.000Z"}}
          },
          "result":null,
          "updatedAt":"2026-04-11T09:00:00.000Z",
          "submittedAt":"2026-04-11T09:00:00.000Z"
        }'::jsonb,
        '[]'::jsonb,
        3,
        '2026-04-11T09:00:00.000Z',
        '2026-04-11T09:00:00.000Z'
      ),
      (
        'user-d',
        'funky:interaction:public_debate_request::entity:22222222::send-yourself',
        '{
          "key":"funky:interaction:public_debate_request::entity:22222222::send-yourself",
          "interactionId":"funky:interaction:public_debate_request",
          "lessonId":"civic-monitor-and-request",
          "kind":"custom",
          "scope":{"type":"entity","entityCui":"22222222"},
          "completionRule":{"type":"resolved"},
          "phase":"pending",
          "value":{
            "kind":"json",
            "json":{"value":{"submissionPath":"send_yourself","submittedAt":"2026-04-09T10:00:00.000Z"}}
          },
          "result":null,
          "updatedAt":"2026-04-09T10:00:00.000Z",
          "submittedAt":"2026-04-09T10:00:00.000Z"
        }'::jsonb,
        '[]'::jsonb,
        4,
        '2026-04-09T10:00:00.000Z',
        '2026-04-09T10:00:00.000Z'
      ),
      (
        'user-e',
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
            "json":{"value":{"websiteUrl":"https://22222222.example","submittedAt":"2026-04-10T15:00:00.000Z"}}
          },
          "result":null,
          "updatedAt":"2026-04-10T15:00:00.000Z",
          "submittedAt":"2026-04-10T15:00:00.000Z"
        }'::jsonb,
        '[]'::jsonb,
        5,
        '2026-04-10T15:00:00.000Z',
        '2026-04-10T15:00:00.000Z'
      ),
      (
        'user-k',
        'funky:interaction:city_hall_website::entity:55555555',
        '{
          "key":"funky:interaction:city_hall_website::entity:55555555",
          "interactionId":"funky:interaction:city_hall_website",
          "lessonId":"civic-monitor-and-request",
          "kind":"custom",
          "scope":{"type":"entity","entityCui":"55555555"},
          "completionRule":{"type":"resolved"},
          "phase":"resolved",
          "value":{
            "kind":"json",
            "json":{"value":{"websiteUrl":"https://55555555.example","submittedAt":"2026-04-08T08:00:00.000Z"}}
          },
          "result":null,
          "review":{"status":"approved","reviewedAt":"2026-04-08T08:00:00.000Z"},
          "updatedAt":"2026-04-08T08:00:00.000Z",
          "submittedAt":"2026-04-08T08:00:00.000Z"
        }'::jsonb,
        '[]'::jsonb,
        6,
        '2026-04-08T08:00:00.000Z',
        '2026-04-08T08:00:00.000Z'
      )
  `);

  await client.query(`
    INSERT INTO notifications (id, user_id, entity_cui, notification_type, is_active, config, hash, created_at, updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'user-a', NULL, 'funky:notification:global', TRUE, NULL, 'hash-1', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000002', 'user-a', '11111111', 'funky:notification:entity_updates', TRUE, NULL, 'hash-2', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000003', 'user-b', NULL, 'funky:notification:global', TRUE, NULL, 'hash-3', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000004', 'user-c', NULL, 'funky:notification:global', TRUE, NULL, 'hash-4', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000005', 'user-c', '11111111', 'funky:notification:entity_updates', TRUE, NULL, 'hash-5', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000006', 'user-d', NULL, 'funky:notification:global', TRUE, NULL, 'hash-6', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000007', 'user-h', NULL, 'funky:notification:global', TRUE, NULL, 'hash-7', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000008', 'user-h', '22222222', 'funky:notification:entity_updates', TRUE, NULL, 'hash-8', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000009', 'user-z', NULL, 'funky:notification:global', TRUE, NULL, 'hash-9', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000010', 'user-z', '33333333', 'funky:notification:entity_updates', TRUE, NULL, 'hash-10', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000011', 'user-i', NULL, 'funky:notification:global', FALSE, NULL, 'hash-11', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000012', 'user-i', '11111111', 'funky:notification:entity_updates', TRUE, NULL, 'hash-12', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000013', 'user-j', NULL, 'funky:notification:global', TRUE, NULL, 'hash-13', NOW(), NOW()),
      ('00000000-0000-0000-0000-000000000014', 'user-j', '11111111', 'funky:notification:entity_updates', TRUE, NULL, 'hash-14', NOW(), NOW()),
      (
        '00000000-0000-0000-0000-000000000015',
        'user-j',
        NULL,
        'global_unsubscribe',
        FALSE,
        '{"channels":{"email":false}}'::jsonb,
        'hash-15',
        NOW(),
        NOW()
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
        '10000000-0000-0000-0000-000000000001',
        'user-a',
        'funky:outbox:welcome',
        NULL,
        'funky:delivery:welcome',
        'welcome-user-a-11111111',
        'delivered',
        1,
        '2026-04-10T08:01:00.000Z'::timestamptz,
        jsonb_build_object('campaignKey', 'funky', 'entityCui', '11111111'),
        '2026-04-10T08:00:00.000Z'::timestamptz
      ),
      (
        '10000000-0000-0000-0000-000000000002',
        'user-c',
        'funky:outbox:entity_update',
        'notif-1111-update',
        'funky:delivery:entity-update-11111111',
        'entity-update-user-c-11111111',
        'failed_permanent',
        2,
        NULL,
        jsonb_build_object('campaignKey', 'funky', 'entityCui', '11111111'),
        '2026-04-11T13:00:00.000Z'::timestamptz
      ),
      (
        '10000000-0000-0000-0000-000000000003',
        'user-a',
        'funky:outbox:entity_subscription',
        NULL,
        'funky:delivery:entity-subscription-11111111',
        'entity-subscription-user-a-11111111',
        'suppressed',
        1,
        NULL,
        jsonb_build_object('campaignKey', 'funky', 'entityCui', '11111111'),
        '2026-04-12T09:00:00.000Z'::timestamptz
      ),
      (
        '10000000-0000-0000-0000-000000000004',
        'admin-review',
        'funky:outbox:admin_failure',
        NULL,
        'funky:delivery:admin-failure-11111111',
        'admin-failure-11111111',
        'failed_permanent',
        1,
        NULL,
        jsonb_build_object('campaignKey', 'funky', 'entityCui', '11111111', 'failureMessage', 'secret'),
        '2026-04-12T10:00:00.000Z'::timestamptz
      ),
      (
        '10000000-0000-0000-0000-000000000005',
        'user-h',
        'funky:outbox:entity_update',
        'notif-2222-update',
        'funky:delivery:entity-update-22222222',
        'entity-update-user-h-22222222',
        'delivered',
        1,
        '2026-04-10T16:01:00.000Z'::timestamptz,
        jsonb_build_object('campaignKey', 'funky', 'entityCui', '22222222'),
        '2026-04-10T16:00:00.000Z'::timestamptz
      ),
      (
        '10000000-0000-0000-0000-000000000006',
        'user-x',
        'funky:outbox:entity_update',
        'notif-4444-update',
        'funky:delivery:entity-update-44444444',
        'entity-update-user-x-44444444',
        'pending',
        0,
        NULL,
        jsonb_build_object('campaignKey', 'funky', 'entityCui', '44444444'),
        '2026-04-12T07:00:00.000Z'::timestamptz
      ),
      (
        '10000000-0000-0000-0000-000000000007',
        'user-y',
        'funky:outbox:welcome',
        NULL,
        'funky:delivery:welcome-44444444',
        'welcome-user-y-44444444',
        'webhook_timeout',
        3,
        NULL,
        jsonb_build_object('campaignKey', 'funky', 'entityCui', '44444444'),
        '2026-04-12T08:00:00.000Z'::timestamptz
      )
  `);
}

async function listAllPages(input: {
  repo: ReturnType<typeof makeCampaignAdminEntitiesRepo>;
  sortBy: CampaignAdminEntitySortBy;
  sortOrder: CampaignAdminEntitySortOrder;
}): Promise<string[]> {
  const entityCuis: string[] = [];
  let cursor: CampaignAdminEntityCursor | undefined;

  while (true) {
    const result = await input.repo.listCampaignAdminEntities({
      campaignKey: 'funky',
      interactions: DEFAULT_INTERACTIONS,
      reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
      limit: 1,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return entityCuis;
    }

    entityCuis.push(...result.value.items.map((item) => item.entityCui));
    if (result.value.nextCursor === null) {
      break;
    }

    cursor = result.value.nextCursor;
  }

  return entityCuis;
}

describe('campaign-admin entities repo', () => {
  const startedContainers: StartedPostgreSqlContainer[] = [];

  afterAll(async () => {
    await Promise.all(startedContainers.map(async (container) => container.stop()));
  });

  it('aggregates entity rows across interactions, subscribers, and outbox activity', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();
    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      await withPgClient(connectionString, async (client) => {
        await client.query(USER_SCHEMA);
        await seedCampaignAdminEntitiesFixture(client);
      });

      const repo = makeCampaignAdminEntitiesRepo({
        db: userDb,
        entityRepo: makeEntityRepoStub(ENTITY_NAMES),
        logger: createPinoLogger({ level: 'silent' }),
      });

      const result = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
      });

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }

      expect(result.value.items).toEqual([
        {
          entityCui: '11111111',
          entityName: 'Municipiul Exemplu',
          userCount: 3,
          interactionCount: 3,
          pendingReviewCount: 1,
          notificationSubscriberCount: 2,
          notificationOutboxCount: 3,
          failedNotificationCount: 2,
          hasPendingReviews: true,
          hasSubscribers: true,
          hasNotificationActivity: true,
          hasFailedNotifications: true,
          latestInteractionAt: '2026-04-11T09:00:00.000Z',
          latestInteractionId: 'funky:interaction:funky_participation',
          latestNotificationAt: '2026-04-12T09:00:00.000Z',
          latestNotificationType: 'funky:outbox:entity_subscription',
          latestNotificationStatus: 'suppressed',
        },
        {
          entityCui: '22222222',
          entityName: 'Comuna Doi',
          userCount: 3,
          interactionCount: 2,
          pendingReviewCount: 1,
          notificationSubscriberCount: 1,
          notificationOutboxCount: 1,
          failedNotificationCount: 0,
          hasPendingReviews: true,
          hasSubscribers: true,
          hasNotificationActivity: true,
          hasFailedNotifications: false,
          latestInteractionAt: '2026-04-10T15:00:00.000Z',
          latestInteractionId: 'funky:interaction:city_hall_website',
          latestNotificationAt: '2026-04-10T16:00:00.000Z',
          latestNotificationType: 'funky:outbox:entity_update',
          latestNotificationStatus: 'delivered',
        },
        {
          entityCui: '33333333',
          entityName: 'Orasul Trei',
          userCount: 1,
          interactionCount: 0,
          pendingReviewCount: 0,
          notificationSubscriberCount: 1,
          notificationOutboxCount: 0,
          failedNotificationCount: 0,
          hasPendingReviews: false,
          hasSubscribers: true,
          hasNotificationActivity: false,
          hasFailedNotifications: false,
          latestInteractionAt: null,
          latestInteractionId: null,
          latestNotificationAt: null,
          latestNotificationType: null,
          latestNotificationStatus: null,
        },
        {
          entityCui: '44444444',
          entityName: 'Comuna Patru',
          userCount: 0,
          interactionCount: 0,
          pendingReviewCount: 0,
          notificationSubscriberCount: 0,
          notificationOutboxCount: 2,
          failedNotificationCount: 1,
          hasPendingReviews: false,
          hasSubscribers: false,
          hasNotificationActivity: true,
          hasFailedNotifications: true,
          latestInteractionAt: null,
          latestInteractionId: null,
          latestNotificationAt: '2026-04-12T08:00:00.000Z',
          latestNotificationType: 'funky:outbox:welcome',
          latestNotificationStatus: 'webhook_timeout',
        },
        {
          entityCui: '55555555',
          entityName: 'Municipiul Cinci',
          userCount: 1,
          interactionCount: 1,
          pendingReviewCount: 0,
          notificationSubscriberCount: 0,
          notificationOutboxCount: 0,
          failedNotificationCount: 0,
          hasPendingReviews: false,
          hasSubscribers: false,
          hasNotificationActivity: false,
          hasFailedNotifications: false,
          latestInteractionAt: '2026-04-08T08:00:00.000Z',
          latestInteractionId: 'funky:interaction:city_hall_website',
          latestNotificationAt: null,
          latestNotificationType: null,
          latestNotificationStatus: null,
        },
      ]);
      expect(result.value.hasMore).toBe(false);
      expect(result.value.nextCursor).toBeNull();
    } finally {
      await userDb.destroy();
    }
  });

  it('normalizes subscriber entity CUIs for exact lookup and ignores blank subscriber rows', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();
    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      await withPgClient(connectionString, async (client) => {
        await client.query(USER_SCHEMA);
        await seedCampaignAdminEntitiesFixture(client);

        await client.query(`
          INSERT INTO notifications (id, user_id, entity_cui, notification_type, is_active, config, hash)
          VALUES
            (
              '00000000-0000-0000-0000-000000000101',
              'user-padded',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-padded-global'
            ),
            (
              '00000000-0000-0000-0000-000000000102',
              'user-padded',
              ' 33333333 ',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-padded-entity'
            ),
            (
              '00000000-0000-0000-0000-000000000103',
              'user-blank',
              NULL,
              'funky:notification:global',
              TRUE,
              NULL,
              'hash-blank-global'
            ),
            (
              '00000000-0000-0000-0000-000000000104',
              'user-blank',
              '   ',
              'funky:notification:entity_updates',
              TRUE,
              NULL,
              'hash-blank-entity'
            )
        `);
      });

      const repo = makeCampaignAdminEntitiesRepo({
        db: userDb,
        entityRepo: makeEntityRepoStub(ENTITY_NAMES),
        logger: createPinoLogger({ level: 'silent' }),
      });

      const exactEntityResult = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        entityCui: '33333333',
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
      });

      expect(exactEntityResult.isOk()).toBe(true);
      if (exactEntityResult.isErr()) {
        return;
      }

      expect(exactEntityResult.value.items).toEqual([
        expect.objectContaining({
          entityCui: '33333333',
          userCount: 2,
          notificationSubscriberCount: 2,
        }),
      ]);

      const allEntitiesResult = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
      });

      expect(allEntitiesResult.isOk()).toBe(true);
      if (allEntitiesResult.isErr()) {
        return;
      }

      expect(allEntitiesResult.value.items.map((item) => item.entityCui)).toEqual([
        '11111111',
        '22222222',
        '33333333',
        '44444444',
        '55555555',
      ]);
    } finally {
      await userDb.destroy();
    }
  });

  it('applies allowlisted filters without changing campaign-wide notification aggregates', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();
    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      await withPgClient(connectionString, async (client) => {
        await client.query(USER_SCHEMA);
        await seedCampaignAdminEntitiesFixture(client);
      });

      const repo = makeCampaignAdminEntitiesRepo({
        db: userDb,
        entityRepo: makeEntityRepoStub(ENTITY_NAMES),
        logger: createPinoLogger({ level: 'silent' }),
      });

      const interactionFiltered = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        interactionId: 'funky:interaction:public_debate_request',
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
      });

      expect(interactionFiltered.isOk()).toBe(true);
      if (interactionFiltered.isErr()) {
        return;
      }

      expect(interactionFiltered.value.items).toEqual([
        expect.objectContaining({
          entityCui: '11111111',
          interactionCount: 1,
          pendingReviewCount: 1,
          notificationSubscriberCount: 2,
          notificationOutboxCount: 3,
        }),
        expect.objectContaining({
          entityCui: '22222222',
          interactionCount: 1,
          pendingReviewCount: 0,
          notificationSubscriberCount: 1,
          notificationOutboxCount: 1,
        }),
      ]);

      const latestNotificationFiltered = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        hasFailedNotifications: true,
        latestNotificationStatus: 'webhook_timeout',
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
      });

      expect(latestNotificationFiltered.isOk()).toBe(true);
      if (latestNotificationFiltered.isErr()) {
        return;
      }

      expect(latestNotificationFiltered.value.items.map((item) => item.entityCui)).toEqual([
        '44444444',
      ]);

      const queryFiltered = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        query: '3333',
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
      });

      expect(queryFiltered.isOk()).toBe(true);
      if (queryFiltered.isErr()) {
        return;
      }

      expect(queryFiltered.value.items.map((item) => item.entityCui)).toEqual(['33333333']);
    } finally {
      await userDb.destroy();
    }
  });

  it('supports keyset pagination with entity_cui as the stable tie-breaker', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();
    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      await withPgClient(connectionString, async (client) => {
        await client.query(USER_SCHEMA);
        await seedCampaignAdminEntitiesFixture(client);
      });

      const repo = makeCampaignAdminEntitiesRepo({
        db: userDb,
        entityRepo: makeEntityRepoStub(ENTITY_NAMES),
        logger: createPinoLogger({ level: 'silent' }),
      });

      const firstPage = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        sortBy: 'notificationOutboxCount',
        sortOrder: 'desc',
        limit: 2,
      });

      expect(firstPage.isOk()).toBe(true);
      if (firstPage.isErr()) {
        return;
      }

      expect(firstPage.value.items.map((item) => item.entityCui)).toEqual(['11111111', '44444444']);
      expect(firstPage.value.hasMore).toBe(true);
      expect(firstPage.value.nextCursor).toEqual({
        sortBy: 'notificationOutboxCount',
        sortOrder: 'desc',
        entityCui: '44444444',
        value: 2,
      });

      const secondPage = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        sortBy: 'notificationOutboxCount',
        sortOrder: 'desc',
        limit: 2,
        ...(firstPage.value.nextCursor !== null ? { cursor: firstPage.value.nextCursor } : {}),
      });

      expect(secondPage.isOk()).toBe(true);
      if (secondPage.isErr()) {
        return;
      }

      expect(secondPage.value.items.map((item) => item.entityCui)).toEqual([
        '22222222',
        '33333333',
      ]);

      const allEntityCuis = await listAllPages({
        repo,
        sortBy: 'notificationOutboxCount',
        sortOrder: 'desc',
      });

      expect(allEntityCuis).toEqual(['11111111', '44444444', '22222222', '33333333', '55555555']);
    } finally {
      await userDb.destroy();
    }
  });

  it('returns repo-level meta counts for the entity summary surface', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();
    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      await withPgClient(connectionString, async (client) => {
        await client.query(USER_SCHEMA);
        await seedCampaignAdminEntitiesFixture(client);
      });

      const repo = makeCampaignAdminEntitiesRepo({
        db: userDb,
        entityRepo: makeEntityRepoStub(ENTITY_NAMES),
        logger: createPinoLogger({ level: 'silent' }),
      });

      const result = await repo.getCampaignAdminEntitiesMetaCounts({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
      });

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }

      expect(result.value).toEqual({
        totalEntities: 5,
        entitiesWithPendingReviews: 2,
        entitiesWithSubscribers: 3,
        entitiesWithNotificationActivity: 3,
        entitiesWithFailedNotifications: 2,
      });
    } finally {
      await userDb.destroy();
    }
  });

  it('fails closed on unsupported sorts, notification filters, and cursor mismatches', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();
    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      await withPgClient(connectionString, async (client) => {
        await client.query(USER_SCHEMA);
        await seedCampaignAdminEntitiesFixture(client);
      });

      const repo = makeCampaignAdminEntitiesRepo({
        db: userDb,
        entityRepo: makeEntityRepoStub(ENTITY_NAMES),
        logger: createPinoLogger({ level: 'silent' }),
      });

      const invalidSort = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        sortBy: 'entityName' as unknown as CampaignAdminEntitySortBy,
        sortOrder: 'asc',
        limit: 10,
      });

      expect(invalidSort.isErr()).toBe(true);
      if (invalidSort.isOk()) {
        return;
      }

      expect(invalidSort.error).toEqual({
        type: 'ValidationError',
        message: 'Unsupported entity sort "entityName".',
      });

      const invalidNotificationType = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        latestNotificationType: 'funky:outbox:admin_failure' as never,
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
      });

      expect(invalidNotificationType.isErr()).toBe(true);
      if (invalidNotificationType.isOk()) {
        return;
      }

      expect(invalidNotificationType.error).toEqual({
        type: 'ValidationError',
        message: 'Unsupported latestNotificationType "funky:outbox:admin_failure".',
      });

      const cursorMismatch = await repo.listCampaignAdminEntities({
        campaignKey: 'funky',
        interactions: DEFAULT_INTERACTIONS,
        reviewableInteractions: DEFAULT_REVIEWABLE_INTERACTIONS,
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 10,
        cursor: {
          sortBy: 'interactionCount',
          sortOrder: 'desc',
          entityCui: '11111111',
          value: 3,
        },
      });

      expect(cursorMismatch.isErr()).toBe(true);
      if (cursorMismatch.isOk()) {
        return;
      }

      expect(cursorMismatch.error).toEqual({
        type: 'ValidationError',
        message: 'Entity cursor sort does not match the requested sort.',
      });
    } finally {
      await userDb.destroy();
    }
  });
});
