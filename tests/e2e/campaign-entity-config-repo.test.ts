import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import {
  buildCampaignEntityConfigRecordKey,
  buildCampaignEntityConfigUserId,
} from '@/modules/campaign-entity-config/core/config-record.js';
import { listCampaignEntityConfigs } from '@/modules/campaign-entity-config/core/usecases/list-campaign-entity-configs.js';
import { upsertCampaignEntityConfig } from '@/modules/campaign-entity-config/core/usecases/upsert-campaign-entity-config.js';
import {
  makeLearningProgressRepo,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

import { dockerAvailable } from './setup.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
import type {
  EntityConnection,
  Entity,
  EntityFilter,
  EntityRepository,
} from '@/modules/entity/index.js';

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

function makeEntityRepo(existingEntityCuis: readonly string[]): EntityRepository {
  const knownEntityCuis = new Set(existingEntityCuis);
  const getEntity = (cui: string): Entity | null =>
    knownEntityCuis.has(cui)
      ? ({
          cui,
          name: `Entity ${cui}`,
          entity_type: null,
          default_report_type: 'atv',
          uat_id: null,
          is_uat: false,
          address: null,
          last_updated: null,
          main_creditor_1_cui: null,
          main_creditor_2_cui: null,
        } as unknown as Entity)
      : null;

  const emptyConnection: EntityConnection = {
    nodes: [],
    pageInfo: {
      totalCount: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    },
  };

  return {
    async getById(cui) {
      return ok(getEntity(cui));
    },
    async getByIds(cuis) {
      return ok(
        new Map(
          cuis
            .map((cui) => getEntity(cui))
            .filter((entity): entity is Entity => entity !== null)
            .map((entity) => [entity.cui, entity])
        )
      );
    },
    async getAll(_filter: EntityFilter, _limit: number, _offset: number) {
      return ok(emptyConnection);
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

function makeRepo(connectionString: string): LearningProgressRepository {
  return makeLearningProgressRepo({
    db: createKyselyClient<UserDatabase>(connectionString),
    logger: pinoLogger({ level: 'silent' }),
  });
}

describe('campaign entity config persistence', () => {
  it('stores config rows in the synthetic campaign bucket and lists them back in canonical shape', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const repo = makeRepo(database.connectionString);
    const entityRepo = makeEntityRepo(['12345678', '87654321']);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);
      });

      const firstResult = await upsertCampaignEntityConfig(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: '12345678',
          values: {
            budgetPublicationDate: '2026-02-01',
            officialBudgetUrl: 'https://example.com/first.pdf',
          },
          expectedUpdatedAt: null,
          actorUserId: 'admin-1',
        }
      );

      expect(firstResult.isOk()).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 5));

      const secondResult = await upsertCampaignEntityConfig(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: '87654321',
          values: {
            budgetPublicationDate: '2026-02-02',
            officialBudgetUrl: 'https://example.com/second.pdf',
          },
          expectedUpdatedAt: null,
          actorUserId: 'admin-2',
        }
      );

      expect(secondResult.isOk()).toBe(true);

      const storedRowResult = await repo.getRecord(
        buildCampaignEntityConfigUserId('funky'),
        buildCampaignEntityConfigRecordKey('12345678')
      );

      expect(storedRowResult.isOk()).toBe(true);
      expect(storedRowResult._unsafeUnwrap()).toMatchObject({
        userId: 'internal:campaign-config:funky',
        recordKey: 'internal:entity-config::12345678',
        record: {
          interactionId: 'internal:campaign-entity-config',
          lessonId: 'internal',
          kind: 'custom',
          scope: { type: 'global' },
          phase: 'resolved',
          completionRule: { type: 'resolved' },
          result: null,
        },
        auditEvents: [],
      });

      const listResult = await listCampaignEntityConfigs(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          limit: 50,
        }
      );

      expect(listResult.isOk()).toBe(true);
      expect(listResult._unsafeUnwrap().items.map((item) => item.entityCui)).toEqual([
        '87654321',
        '12345678',
      ]);
    } finally {
      await database.stop();
    }
  });

  it('returns conflicts for duplicate create and stale update attempts', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const repo = makeRepo(database.connectionString);
    const entityRepo = makeEntityRepo(['12345678']);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);
      });

      const created = await upsertCampaignEntityConfig(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: '12345678',
          values: {
            budgetPublicationDate: '2026-02-01',
            officialBudgetUrl: 'https://example.com/first.pdf',
          },
          expectedUpdatedAt: null,
          actorUserId: 'admin-1',
        }
      );

      expect(created.isOk()).toBe(true);

      const duplicateCreate = await upsertCampaignEntityConfig(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: '12345678',
          values: {
            budgetPublicationDate: '2026-02-02',
            officialBudgetUrl: 'https://example.com/second.pdf',
          },
          expectedUpdatedAt: null,
          actorUserId: 'admin-1',
        }
      );

      expect(duplicateCreate.isErr()).toBe(true);
      expect(duplicateCreate._unsafeUnwrapErr().type).toBe('ConflictError');

      const updated = await upsertCampaignEntityConfig(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: '12345678',
          values: {
            budgetPublicationDate: '2026-02-03',
            officialBudgetUrl: 'https://example.com/third.pdf',
          },
          expectedUpdatedAt: created._unsafeUnwrap().updatedAt,
          actorUserId: 'admin-2',
        }
      );

      expect(updated.isOk()).toBe(true);

      const staleUpdate = await upsertCampaignEntityConfig(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: '12345678',
          values: {
            budgetPublicationDate: '2026-02-04',
            officialBudgetUrl: 'https://example.com/fourth.pdf',
          },
          expectedUpdatedAt: created._unsafeUnwrap().updatedAt,
          actorUserId: 'admin-3',
        }
      );

      expect(staleUpdate.isErr()).toBe(true);
      expect(staleUpdate._unsafeUnwrapErr().type).toBe('ConflictError');
    } finally {
      await database.stop();
    }
  });

  it('pages campaign entity config rows in the repository using stable keyset filters', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const repo = makeRepo(database.connectionString);
    const entityRepo = makeEntityRepo(['11111111', '22222222', '33333333']);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);
      });

      for (const item of [
        {
          entityCui: '11111111',
          actorUserId: 'admin-1',
          budgetPublicationDate: '2026-02-01',
          officialBudgetUrl: 'https://example.com/first.pdf',
        },
        {
          entityCui: '22222222',
          actorUserId: 'admin-2',
          budgetPublicationDate: '2026-02-02',
          officialBudgetUrl: 'https://example.com/second.pdf',
        },
        {
          entityCui: '33333333',
          actorUserId: 'admin-3',
          budgetPublicationDate: '2026-02-03',
          officialBudgetUrl: 'https://example.com/third.pdf',
        },
      ] as const) {
        const result = await upsertCampaignEntityConfig(
          {
            learningProgressRepo: repo,
            entityRepo,
          },
          {
            campaignKey: 'funky',
            entityCui: item.entityCui,
            values: {
              budgetPublicationDate: item.budgetPublicationDate,
              officialBudgetUrl: item.officialBudgetUrl,
            },
            expectedUpdatedAt: null,
            actorUserId: item.actorUserId,
          }
        );

        expect(result.isOk()).toBe(true);
      }

      await withPgClient(database.connectionString, async (client) => {
        await client.query(
          `
            UPDATE userinteractions
            SET updated_at = CASE record_key
              WHEN 'internal:entity-config::33333333' THEN '2026-04-18T12:00:00.000Z'::timestamptz
              WHEN 'internal:entity-config::11111111' THEN '2026-04-18T11:00:00.000Z'::timestamptz
              WHEN 'internal:entity-config::22222222' THEN '2026-04-18T11:00:00.000Z'::timestamptz
              ELSE updated_at
            END
            WHERE user_id = 'internal:campaign-config:funky'
          `
        );
      });

      const firstPageResult = await listCampaignEntityConfigs(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          limit: 2,
        }
      );

      expect(firstPageResult.isOk()).toBe(true);
      expect(firstPageResult._unsafeUnwrap()).toMatchObject({
        totalCount: 3,
        items: [{ entityCui: '33333333' }, { entityCui: '11111111' }],
        hasMore: true,
        nextCursor: {
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          updatedAt: '2026-04-18T11:00:00.000Z',
          entityCui: '11111111',
        },
      });
      const firstPageCursor = firstPageResult._unsafeUnwrap().nextCursor;

      const secondPageResult = await listCampaignEntityConfigs(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          limit: 2,
          ...(firstPageCursor !== null ? { cursor: firstPageCursor } : {}),
        }
      );

      expect(secondPageResult.isOk()).toBe(true);
      expect(secondPageResult._unsafeUnwrap()).toMatchObject({
        totalCount: 3,
        items: [{ entityCui: '22222222' }],
        hasMore: false,
        nextCursor: null,
      });

      const exactFilterResult = await listCampaignEntityConfigs(
        {
          learningProgressRepo: repo,
          entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: '22222222',
          updatedAtFrom: '2026-04-18T10:30:00.000Z',
          updatedAtTo: '2026-04-18T11:30:00.000Z',
          sortBy: 'entityCui',
          sortOrder: 'asc',
          limit: 50,
        }
      );

      expect(exactFilterResult.isOk()).toBe(true);
      expect(exactFilterResult._unsafeUnwrap()).toMatchObject({
        totalCount: 1,
        items: [{ entityCui: '22222222' }],
        hasMore: false,
        nextCursor: null,
      });
    } finally {
      await database.stop();
    }
  });

  it('treats corrupted persisted rows as integrity failures', async () => {
    if (!dockerAvailable) {
      return;
    }

    const database = await startTestDatabase();
    const repo = makeRepo(database.connectionString);

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(USER_SCHEMA);
        await client.query(`
          INSERT INTO userinteractions (user_id, record_key, record, audit_events, updated_seq, created_at, updated_at)
          VALUES (
            'internal:campaign-config:funky',
            'internal:entity-config::12345678',
            '{
              "key":"internal:entity-config::12345678",
              "interactionId":"funky:interaction:budget_document",
              "lessonId":"internal",
              "kind":"custom",
              "scope":{"type":"global"},
              "completionRule":{"type":"resolved"},
              "phase":"resolved",
              "value":{
                "kind":"json",
                "json":{
                  "value":{
                    "version":1,
                    "campaignKey":"funky",
                    "entityCui":"12345678",
                    "values":{
                      "budgetPublicationDate":"2026-02-01",
                      "officialBudgetUrl":"https://example.com/budget.pdf"
                    },
                    "meta":{"updatedByUserId":"admin-1"}
                  }
                }
              },
              "result":null,
              "updatedAt":"2026-04-18T10:00:00.000Z"
            }'::jsonb,
            '[]'::jsonb,
            1,
            '2026-04-18T10:00:00.000Z',
            '2026-04-18T10:00:00.000Z'
          )
        `);
      });

      const result = await listCampaignEntityConfigs(
        {
          learningProgressRepo: repo,
          entityRepo: makeEntityRepo([]),
        },
        {
          campaignKey: 'funky',
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          limit: 50,
        }
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: 'DatabaseError',
        retryable: false,
      });
    } finally {
      await database.stop();
    }
  });
});
