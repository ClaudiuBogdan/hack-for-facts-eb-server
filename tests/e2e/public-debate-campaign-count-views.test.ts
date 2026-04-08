import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { dockerAvailable } from './setup.js';

const USER_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
  'utf-8'
);

const PUBLIC_DEBATE_CAMPAIGN_COUNT_VIEWS_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202604081100_add_public_debate_campaign_count_views.sql'
  ),
  'utf-8'
);

const LEGACY_NOTIFICATIONS_SCHEMA = `
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_cui VARCHAR(20) NULL,
  notification_type VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB,
  hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

interface StartedTestDatabase {
  connectionString: string;
  stop: () => Promise<void>;
}

interface TotalUsersRow {
  campaign_key: string;
  total_users: string;
}

interface UatUsersRow {
  campaign_key: string;
  entity_cui: string;
  total_users: string;
}

interface NotificationSeedRow {
  userId: string;
  notificationType: string;
  entityCui?: string | null;
  isActive?: boolean;
  config?: Record<string, unknown> | null;
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

async function seedCampaignNotifications(
  client: pg.Client,
  scope: string,
  rows: readonly NotificationSeedRow[]
): Promise<void> {
  for (const [index, row] of rows.entries()) {
    await client.query(
      `
        INSERT INTO notifications (
          id,
          user_id,
          entity_cui,
          notification_type,
          is_active,
          config,
          hash
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
      `,
      [
        randomUUID(),
        `${scope}:${row.userId}`,
        row.entityCui ?? null,
        row.notificationType,
        row.isActive ?? true,
        row.config === undefined || row.config === null ? null : JSON.stringify(row.config),
        `${scope}:hash:${String(index)}:${row.userId}:${row.notificationType}:${row.entityCui ?? 'global'}`,
      ]
    );
  }
}

async function assertCampaignCountViews(client: pg.Client): Promise<void> {
  const totalUsers = await client.query<TotalUsersRow>(
    `
      SELECT campaign_key, total_users
      FROM v_public_debate_campaign_user_total
    `
  );

  expect(totalUsers.rows).toEqual([{ campaign_key: 'funky', total_users: '4' }]);

  const uatUsers = await client.query<UatUsersRow>(
    `
      SELECT campaign_key, entity_cui, total_users
      FROM v_public_debate_uat_user_counts
      ORDER BY entity_cui ASC
    `
  );

  expect(uatUsers.rows).toEqual([
    { campaign_key: 'funky', entity_cui: '4305857', total_users: '2' },
    { campaign_key: 'funky', entity_cui: '4485391', total_users: '1' },
  ]);
}

const CAMPAIGN_FIXTURE_ROWS: readonly NotificationSeedRow[] = [
  { userId: 'user-1', notificationType: 'funky:notification:global' },
  {
    userId: 'user-1',
    notificationType: 'funky:notification:entity_updates',
    entityCui: '4305857',
  },
  {
    userId: 'user-1',
    notificationType: 'funky:notification:entity_updates',
    entityCui: '4485391',
  },
  { userId: 'user-2', notificationType: 'funky:notification:global' },
  {
    userId: 'user-2',
    notificationType: 'funky:notification:entity_updates',
    entityCui: '4305857',
  },
  { userId: 'user-3', notificationType: 'funky:notification:global' },
  {
    userId: 'user-3',
    notificationType: 'funky:notification:entity_updates',
    entityCui: '4485391',
  },
  {
    userId: 'user-3',
    notificationType: 'global_unsubscribe',
    isActive: false,
    config: { channels: { email: false } },
  },
  { userId: 'user-4', notificationType: 'funky:notification:global', isActive: false },
  {
    userId: 'user-4',
    notificationType: 'funky:notification:entity_updates',
    entityCui: '4305857',
  },
  { userId: 'user-5', notificationType: 'funky:notification:global' },
  {
    userId: 'user-5',
    notificationType: 'funky:notification:entity_updates',
    entityCui: '4305857',
    isActive: false,
  },
  { userId: 'user-6', notificationType: 'funky:notification:global' },
  { userId: 'user-7', notificationType: 'funky:notification:global' },
  {
    userId: 'user-7',
    notificationType: 'funky:notification:entity_updates',
    entityCui: '4305857',
  },
  {
    userId: 'user-7',
    notificationType: 'global_unsubscribe',
    config: { channels: { email: false } },
  },
];

describe('public debate campaign count views', () => {
  it('exposes the current schema views with campaign and per-UAT counts', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(USER_SCHEMA);
        await seedCampaignNotifications(client, 'schema', CAMPAIGN_FIXTURE_ROWS);

        await assertCampaignCountViews(client);
      });
    } finally {
      await database.stop();
    }
  });

  it('adds the count views for existing user databases via migration', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(LEGACY_NOTIFICATIONS_SCHEMA);
        await client.query(PUBLIC_DEBATE_CAMPAIGN_COUNT_VIEWS_MIGRATION);
        await seedCampaignNotifications(client, 'migration', CAMPAIGN_FIXTURE_ROWS);

        await assertCampaignCountViews(client);
      });
    } finally {
      await database.stop();
    }
  });
});
