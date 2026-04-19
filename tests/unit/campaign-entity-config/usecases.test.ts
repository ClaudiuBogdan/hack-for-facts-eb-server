import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  buildCampaignEntityConfigRecordKey,
  buildCampaignEntityConfigUserId,
  createCampaignEntityConfigRecord,
} from '@/modules/campaign-entity-config/core/config-record.js';
import { getCampaignEntityConfig } from '@/modules/campaign-entity-config/core/usecases/get-campaign-entity-config.js';
import { listCampaignEntityConfigs } from '@/modules/campaign-entity-config/core/usecases/list-campaign-entity-configs.js';
import { upsertCampaignEntityConfig } from '@/modules/campaign-entity-config/core/usecases/upsert-campaign-entity-config.js';

import { makeFakeLearningProgressRepo } from '../../fixtures/fakes.js';

import type {
  EntityConnection,
  Entity,
  EntityFilter,
  EntityRepository,
} from '@/modules/entity/index.js';
import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

function createEntity(input: { cui: string; name?: string }): Entity {
  return {
    cui: input.cui,
    name: input.name ?? `Entity ${input.cui}`,
    entity_type: null,
    default_report_type: 'atv',
    uat_id: null,
    is_uat: false,
    address: null,
    last_updated: null,
    main_creditor_1_cui: null,
    main_creditor_2_cui: null,
  } as unknown as Entity;
}

function makeEntityRepo(
  entitiesInput: readonly (string | { cui: string; name?: string })[],
  options?: {
    onGetById?: (cui: string) => void;
    onGetByIds?: (cuis: readonly string[]) => void;
  }
): EntityRepository {
  const entities = entitiesInput
    .map((entity) =>
      typeof entity === 'string' ? createEntity({ cui: entity }) : createEntity(entity)
    )
    .sort((left, right) => left.cui.localeCompare(right.cui));

  const getEntity = (cui: string): Entity | null =>
    entities.find((entity) => entity.cui === cui) ?? null;

  return {
    async getById(cui) {
      options?.onGetById?.(cui);
      return ok(getEntity(cui));
    },
    async getByIds(cuis) {
      options?.onGetByIds?.(cuis);
      return ok(
        new Map(
          cuis
            .map((cui) => getEntity(cui))
            .filter((entity): entity is Entity => entity !== null)
            .map((entity) => [entity.cui, entity])
        )
      );
    },
    async getAll(filter: EntityFilter, limit: number, offset: number) {
      let filteredEntities = entities;

      if (filter.cui !== undefined) {
        filteredEntities = filteredEntities.filter((entity) => entity.cui === filter.cui);
      }

      if (filter.search !== undefined && filter.search.trim() !== '') {
        const normalizedQuery = filter.search.trim().toLocaleLowerCase('en');
        filteredEntities = filteredEntities.filter(
          (entity) =>
            entity.cui.toLocaleLowerCase('en').includes(normalizedQuery) ||
            entity.name.toLocaleLowerCase('en').includes(normalizedQuery)
        );
      }

      const connection: EntityConnection = {
        nodes: filteredEntities.slice(offset, offset + limit),
        pageInfo: {
          totalCount: filteredEntities.length,
          hasNextPage: offset + limit < filteredEntities.length,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
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

function makeRow(input: {
  entityCui: string;
  values: {
    budgetPublicationDate: string | null;
    officialBudgetUrl: string | null;
  };
  actorUserId: string;
  rowUpdatedAt: string;
  recordUpdatedAt?: string;
}): LearningProgressRecordRow {
  const record = createCampaignEntityConfigRecord({
    campaignKey: 'funky',
    entityCui: input.entityCui,
    values: input.values,
    actorUserId: input.actorUserId,
    recordUpdatedAt: input.recordUpdatedAt ?? input.rowUpdatedAt,
  });

  return {
    userId: buildCampaignEntityConfigUserId('funky'),
    recordKey: buildCampaignEntityConfigRecordKey(input.entityCui),
    record,
    auditEvents: [],
    updatedSeq: '1',
    createdAt: input.rowUpdatedAt,
    updatedAt: input.rowUpdatedAt,
  };
}

describe('campaign entity config use cases', () => {
  it('returns a default unconfigured dto when the entity exists but no row is stored', async () => {
    const result = await getCampaignEntityConfig(
      {
        learningProgressRepo: makeFakeLearningProgressRepo(),
        entityRepo: makeEntityRepo(['12345678']),
      },
      {
        campaignKey: 'funky',
        entityCui: '12345678',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      campaignKey: 'funky',
      entityCui: '12345678',
      entityName: 'Entity 12345678',
      isConfigured: false,
      values: {
        budgetPublicationDate: null,
        officialBudgetUrl: null,
      },
      updatedAt: null,
      updatedByUserId: null,
    });
  });

  it('normalizes blank entity names on default detail responses', async () => {
    const result = await getCampaignEntityConfig(
      {
        learningProgressRepo: makeFakeLearningProgressRepo(),
        entityRepo: makeEntityRepo([{ cui: '12345678', name: '   ' }]),
      },
      {
        campaignKey: 'funky',
        entityCui: '12345678',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      entityCui: '12345678',
      entityName: null,
      isConfigured: false,
    });
  });

  it('enforces create-only and update-only concurrency semantics via expectedUpdatedAt', async () => {
    const repo = makeFakeLearningProgressRepo();
    const entityRepo = makeEntityRepo(['12345678']);

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
          officialBudgetUrl: 'https://example.com/budget.pdf',
        },
        expectedUpdatedAt: null,
        actorUserId: 'admin-1',
      }
    );

    expect(created.isOk()).toBe(true);
    expect(created._unsafeUnwrap()).toMatchObject({
      entityCui: '12345678',
      entityName: 'Entity 12345678',
      updatedByUserId: 'admin-1',
    });

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
          officialBudgetUrl: 'https://example.com/budget-2.pdf',
        },
        expectedUpdatedAt: null,
        actorUserId: 'admin-1',
      }
    );

    expect(duplicateCreate.isErr()).toBe(true);
    expect(duplicateCreate._unsafeUnwrapErr().type).toBe('ConflictError');

    const missingUpdate = await upsertCampaignEntityConfig(
      {
        learningProgressRepo: repo,
        entityRepo: makeEntityRepo(['87654321']),
      },
      {
        campaignKey: 'funky',
        entityCui: '87654321',
        values: {
          budgetPublicationDate: '2026-03-01',
          officialBudgetUrl: 'https://example.com/other.pdf',
        },
        expectedUpdatedAt: '2026-04-18T10:00:00.000Z',
        actorUserId: 'admin-2',
      }
    );

    expect(missingUpdate.isErr()).toBe(true);
    expect(missingUpdate._unsafeUnwrapErr().type).toBe('ConflictError');
  });

  it('keeps the embedded record.updatedAt monotonic even when wall-clock time does not advance', async () => {
    const previousEmbeddedUpdatedAt = '2099-01-01T00:00:00.000Z';
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          buildCampaignEntityConfigUserId('funky'),
          [
            makeRow({
              entityCui: '12345678',
              values: {
                budgetPublicationDate: '2026-02-01',
                officialBudgetUrl: 'https://example.com/budget.pdf',
              },
              actorUserId: 'admin-1',
              rowUpdatedAt: '2026-04-18T10:00:00.000Z',
              recordUpdatedAt: previousEmbeddedUpdatedAt,
            }),
          ],
        ],
      ]),
    });

    const result = await upsertCampaignEntityConfig(
      {
        learningProgressRepo: repo,
        entityRepo: makeEntityRepo(['12345678']),
      },
      {
        campaignKey: 'funky',
        entityCui: '12345678',
        values: {
          budgetPublicationDate: '2026-02-02',
          officialBudgetUrl: 'https://example.com/budget-v2.pdf',
        },
        expectedUpdatedAt: '2026-04-18T10:00:00.000Z',
        actorUserId: 'admin-2',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      entityCui: '12345678',
      entityName: 'Entity 12345678',
      updatedByUserId: 'admin-2',
    });

    const storedRow = await repo.getRecord(
      buildCampaignEntityConfigUserId('funky'),
      buildCampaignEntityConfigRecordKey('12345678')
    );

    expect(storedRow.isOk()).toBe(true);
    expect(storedRow._unsafeUnwrap()?.record.updatedAt).toBe('2099-01-01T00:00:00.001Z');
  });

  it('lists configured rows with stable updatedAt keyset pagination', async () => {
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          buildCampaignEntityConfigUserId('funky'),
          [
            makeRow({
              entityCui: '33333333',
              values: {
                budgetPublicationDate: '2026-02-03',
                officialBudgetUrl: 'https://example.com/third.pdf',
              },
              actorUserId: 'admin-3',
              rowUpdatedAt: '2026-04-18T12:00:00.000Z',
            }),
            makeRow({
              entityCui: '11111111',
              values: {
                budgetPublicationDate: '2026-02-01',
                officialBudgetUrl: 'https://example.com/first.pdf',
              },
              actorUserId: 'admin-1',
              rowUpdatedAt: '2026-04-18T11:00:00.000Z',
            }),
            makeRow({
              entityCui: '22222222',
              values: {
                budgetPublicationDate: '2026-02-02',
                officialBudgetUrl: 'https://example.com/second.pdf',
              },
              actorUserId: 'admin-2',
              rowUpdatedAt: '2026-04-18T11:00:00.000Z',
            }),
          ],
        ],
      ]),
    });
    const getByIdsCalls: string[][] = [];
    const entityRepo = makeEntityRepo(
      [
        { cui: '33333333', name: 'Gamma Town' },
        { cui: '11111111', name: 'Alpha Town' },
        { cui: '22222222', name: 'Beta Village' },
      ],
      {
        onGetByIds(cuis) {
          getByIdsCalls.push([...cuis]);
        },
      }
    );

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
      items: [
        { entityCui: '33333333', entityName: 'Gamma Town' },
        { entityCui: '11111111', entityName: 'Alpha Town' },
      ],
      hasMore: true,
      nextCursor: {
        sortBy: 'updatedAt',
        sortOrder: 'desc',
        updatedAt: '2026-04-18T11:00:00.000Z',
        entityCui: '11111111',
      },
    });
    expect(getByIdsCalls).toHaveLength(1);
    expect(getByIdsCalls[0]).toHaveLength(2);
    expect(getByIdsCalls[0]).toEqual(expect.arrayContaining(['33333333', '11111111']));
    const firstPageCursor = firstPageResult._unsafeUnwrap().nextCursor;
    getByIdsCalls.length = 0;

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
      items: [{ entityCui: '22222222', entityName: 'Beta Village' }],
      hasMore: false,
      nextCursor: null,
    });
    expect(getByIdsCalls).toEqual([['22222222']]);
  });

  it('filters repo-backed lists by updatedAt range and entityCui', async () => {
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          buildCampaignEntityConfigUserId('funky'),
          [
            makeRow({
              entityCui: '87654321',
              values: {
                budgetPublicationDate: '2026-02-03',
                officialBudgetUrl: 'https://example.com/third.pdf',
              },
              actorUserId: 'admin-3',
              rowUpdatedAt: '2026-04-18T13:00:00.000Z',
            }),
            makeRow({
              entityCui: '12345678',
              values: {
                budgetPublicationDate: '2026-02-01',
                officialBudgetUrl: 'https://example.com/first.pdf',
              },
              actorUserId: 'admin-1',
              rowUpdatedAt: '2026-04-18T12:00:00.000Z',
            }),
            makeRow({
              entityCui: '55555555',
              values: {
                budgetPublicationDate: '2026-02-02',
                officialBudgetUrl: 'https://example.com/second.pdf',
              },
              actorUserId: 'admin-2',
              rowUpdatedAt: '2026-04-18T10:00:00.000Z',
            }),
          ],
        ],
      ]),
    });
    const entityRepo = makeEntityRepo([
      { cui: '87654321', name: 'Zulu County' },
      { cui: '12345678', name: 'Alpha Town' },
      { cui: '55555555', name: 'Beta Village' },
    ]);

    const rangedResult = await listCampaignEntityConfigs(
      {
        learningProgressRepo: repo,
        entityRepo,
      },
      {
        campaignKey: 'funky',
        updatedAtFrom: '2026-04-18T11:30:00.000Z',
        updatedAtTo: '2026-04-18T13:30:00.000Z',
        sortBy: 'entityCui',
        sortOrder: 'desc',
        limit: 50,
      }
    );

    expect(rangedResult.isOk()).toBe(true);
    expect(rangedResult._unsafeUnwrap()).toMatchObject({
      totalCount: 2,
      items: [
        { entityCui: '87654321', entityName: 'Zulu County' },
        { entityCui: '12345678', entityName: 'Alpha Town' },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const exactResult = await listCampaignEntityConfigs(
      {
        learningProgressRepo: repo,
        entityRepo,
      },
      {
        campaignKey: 'funky',
        entityCui: '12345678',
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 50,
      }
    );

    expect(exactResult.isOk()).toBe(true);
    expect(exactResult._unsafeUnwrap()).toMatchObject({
      totalCount: 1,
      items: [
        {
          entityCui: '12345678',
          entityName: 'Alpha Town',
          updatedByUserId: 'admin-1',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('attaches entity names to detail and current list page responses', async () => {
    const detailResult = await getCampaignEntityConfig(
      {
        learningProgressRepo: makeFakeLearningProgressRepo(),
        entityRepo: makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
      },
      {
        campaignKey: 'funky',
        entityCui: '12345678',
      }
    );

    expect(detailResult.isOk()).toBe(true);
    expect(detailResult._unsafeUnwrap()).toMatchObject({
      entityCui: '12345678',
      entityName: 'Alpha Town',
    });

    const listResult = await listCampaignEntityConfigs(
      {
        learningProgressRepo: makeFakeLearningProgressRepo({
          initialRecords: new Map([
            [
              buildCampaignEntityConfigUserId('funky'),
              [
                makeRow({
                  entityCui: '12345678',
                  values: {
                    budgetPublicationDate: '2026-02-01',
                    officialBudgetUrl: 'https://example.com/first.pdf',
                  },
                  actorUserId: 'admin-1',
                  rowUpdatedAt: '2026-04-18T12:00:00.000Z',
                }),
              ],
            ],
          ]),
        }),
        entityRepo: makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
      },
      {
        campaignKey: 'funky',
        sortBy: 'updatedAt',
        sortOrder: 'desc',
        limit: 50,
      }
    );

    expect(listResult.isOk()).toBe(true);
    expect(listResult._unsafeUnwrap()).toMatchObject({
      items: [{ entityCui: '12345678', entityName: 'Alpha Town' }],
    });
  });

  it('returns list rows even when entity-name enrichment fails', async () => {
    const result = await listCampaignEntityConfigs(
      {
        learningProgressRepo: makeFakeLearningProgressRepo({
          initialRecords: new Map([
            [
              buildCampaignEntityConfigUserId('funky'),
              [
                makeRow({
                  entityCui: '12345678',
                  values: {
                    budgetPublicationDate: '2026-02-01',
                    officialBudgetUrl: 'https://example.com/first.pdf',
                  },
                  actorUserId: 'admin-1',
                  rowUpdatedAt: '2026-04-18T12:00:00.000Z',
                }),
              ],
            ],
          ]),
        }),
        entityRepo: {
          ...makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
          async getByIds() {
            return err({
              type: 'DatabaseError' as const,
              message: 'Failed to load entity names',
              retryable: true,
            });
          },
        },
      },
      {
        campaignKey: 'funky',
        sortBy: 'updatedAt',
        sortOrder: 'desc',
        limit: 50,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      items: [{ entityCui: '12345678', entityName: null }],
      totalCount: 1,
      hasMore: false,
      nextCursor: null,
    });
  });

  it('rejects query filtering on the paginated list path', async () => {
    const result = await listCampaignEntityConfigs(
      {
        learningProgressRepo: makeFakeLearningProgressRepo(),
        entityRepo: makeEntityRepo([]),
      },
      {
        campaignKey: 'funky',
        query: 'alpha',
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 50,
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'ValidationError',
      message: 'Campaign entity config list query filter is not supported for paginated listing.',
    });
  });
});
