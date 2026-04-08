import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import createPinoLogger from 'pino';
import { afterAll, describe, expect, it } from 'vitest';

import { makeCampaignSubscriptionStatsReader } from '@/modules/campaign-subscription-stats/index.js';

import { dockerAvailable } from './setup.js';

import type { BudgetDatabase } from '@/infra/database/budget/types.js';
import type { UserDatabase } from '@/infra/database/user/types.js';

const { Pool } = pg;

const BUDGET_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/budget/schema.sql'),
  'utf-8'
);
const USER_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
  'utf-8'
);
const INDEX_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202604081300_add_public_debate_campaign_count_indexes.sql'
  ),
  'utf-8'
);

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

async function seedBudgetTables(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO uats (
      id,
      uat_key,
      uat_code,
      siruta_code,
      name,
      county_code,
      county_name,
      region,
      population
    )
    VALUES
      (1, 'cluj-cluj-napoca', '4305857', '179132', 'Cluj-Napoca', 'CJ', 'Cluj', 'Nord-Vest', 286598),
      (2, 'cluj-floresti', '4485391', '55274', 'Floresti', 'CJ', 'Cluj', 'Nord-Vest', 52955)
  `);

  await client.query(`
    INSERT INTO entities (
      cui,
      name,
      uat_id,
      entity_type,
      is_uat
    )
    VALUES
      ('4305857', 'Municipiul Cluj-Napoca', 1, 'uat', TRUE),
      ('4485391', 'Comuna Floresti', 2, 'uat', TRUE)
  `);
}

async function seedCampaignNotifications(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO notifications (id, user_id, entity_cui, notification_type, is_active, config, hash)
    VALUES
      (gen_random_uuid(), 'user-1', NULL, 'funky:notification:global', TRUE, NULL, 'hash-1'),
      (gen_random_uuid(), 'user-1', '4305857', 'funky:notification:entity_updates', TRUE, NULL, 'hash-2'),
      (gen_random_uuid(), 'user-1', '4485391', 'funky:notification:entity_updates', TRUE, NULL, 'hash-3'),
      (gen_random_uuid(), 'user-2', NULL, 'funky:notification:global', TRUE, NULL, 'hash-4'),
      (gen_random_uuid(), 'user-2', '4305857', 'funky:notification:entity_updates', TRUE, NULL, 'hash-5'),
      (gen_random_uuid(), 'user-3', NULL, 'funky:notification:global', TRUE, NULL, 'hash-6'),
      (gen_random_uuid(), 'user-3', '4485391', 'funky:notification:entity_updates', TRUE, NULL, 'hash-7'),
      (
        gen_random_uuid(),
        'user-3',
        NULL,
        'global_unsubscribe',
        FALSE,
        '{"channels":{"email":false}}'::jsonb,
        'hash-8'
      ),
      (gen_random_uuid(), 'user-4', NULL, 'funky:notification:global', FALSE, NULL, 'hash-9'),
      (gen_random_uuid(), 'user-4', '4305857', 'funky:notification:entity_updates', TRUE, NULL, 'hash-10'),
      (gen_random_uuid(), 'user-5', NULL, 'funky:notification:global', TRUE, NULL, 'hash-11'),
      (gen_random_uuid(), 'user-5', '4305857', 'funky:notification:entity_updates', FALSE, NULL, 'hash-12'),
      (gen_random_uuid(), 'user-6', NULL, 'funky:notification:global', TRUE, NULL, 'hash-13'),
      (gen_random_uuid(), 'user-7', NULL, 'funky:notification:global', TRUE, NULL, 'hash-14'),
      (gen_random_uuid(), 'user-7', '4305857', 'funky:notification:entity_updates', TRUE, NULL, 'hash-15'),
      (
        gen_random_uuid(),
        'user-7',
        NULL,
        'global_unsubscribe',
        TRUE,
        '{"channels":{"email":false}}'::jsonb,
        'hash-16'
      )
  `);
}

describe('campaign subscription stats repo', () => {
  const startedContainers: StartedPostgreSqlContainer[] = [];

  afterAll(async () => {
    await Promise.all(startedContainers.map(async (container) => container.stop()));
  });

  it('returns campaign totals and per-UAT counts from the two databases', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();

    await withPgClient(connectionString, async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(BUDGET_SCHEMA);
      await client.query(USER_SCHEMA);
      await seedBudgetTables(client);
      await seedCampaignNotifications(client);
    });

    const budgetDb = createKyselyClient<BudgetDatabase>(connectionString);
    const userDb = createKyselyClient<UserDatabase>(connectionString);

    try {
      const reader = makeCampaignSubscriptionStatsReader({
        budgetDb,
        userDb,
        logger: createPinoLogger({ level: 'silent' }),
      });

      const result = await reader.getByCampaignId('funky');

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }

      expect(result.value).toEqual({
        total: 4,
        perUat: [
          { sirutaCode: '179132', uatName: 'Cluj-Napoca', count: 2 },
          { sirutaCode: '55274', uatName: 'Floresti', count: 1 },
        ],
      });
    } finally {
      await budgetDb.destroy();
      await userDb.destroy();
    }
  });

  it('adds the public-debate aggregation indexes for existing databases via migration', async () => {
    if (!dockerAvailable) {
      return;
    }

    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    startedContainers.push(container);

    const connectionString = container.getConnectionUri();

    await withPgClient(connectionString, async (client) => {
      await client.query(`
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
        )
      `);

      await client.query(INDEX_MIGRATION);

      const indexes = await client.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'notifications'
          AND indexname IN (
            'idx_notifications_funky_global_active_type_user',
            'idx_notifications_funky_entity_active_type_entity_user',
            'idx_notifications_global_unsubscribe_type_user'
          )
        ORDER BY indexname ASC
      `);

      expect(indexes.rows).toEqual([
        { indexname: 'idx_notifications_funky_entity_active_type_entity_user' },
        { indexname: 'idx_notifications_funky_global_active_type_user' },
        { indexname: 'idx_notifications_global_unsubscribe_type_user' },
      ]);
    });
  });
});
