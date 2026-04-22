import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  buildCampaignEntityConfigRecordKey,
  buildCampaignEntityConfigUserId,
  compareCampaignEntityConfigDtos,
  createCampaignEntityConfigRecord,
} from '@/modules/campaign-entity-config/core/config-record.js';
import { makeCampaignEntityConfigRoutes } from '@/modules/campaign-entity-config/index.js';

import { makeFakeLearningProgressRepo } from '../fixtures/fakes.js';

import type {
  CampaignEntityConfigListItem,
  CampaignEntityConfigValues,
} from '@/modules/campaign-entity-config/core/types.js';
import type {
  EntityConnection,
  Entity,
  EntityFilter,
  EntityRepository,
} from '@/modules/entity/index.js';
import type {
  LearningProgressRecordRow,
  LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

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
    onGetAll?: (input: { filter: EntityFilter; limit: number; offset: number }) => void;
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
      options?.onGetAll?.({
        filter,
        limit,
        offset,
      });

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

      const nodes = filteredEntities.slice(offset, offset + limit);
      const connection: EntityConnection = {
        nodes,
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

function makeAudienceReader() {
  return {};
}

const TEST_AUTH_USER_1 = 'user_test_1';

function makeAcceptedTermsRow(input: {
  userId?: string;
  entityCui: string;
  updatedAt: string;
}): LearningProgressRecordRow {
  return {
    userId: input.userId ?? 'user-accepted-1',
    recordKey: `funky:progress:terms_accepted::entity:${input.entityCui}`,
    record: {
      key: `funky:progress:terms_accepted::entity:${input.entityCui}`,
      interactionId: `funky:progress:terms_accepted::entity:${input.entityCui}`,
      lessonId: 'funky:progress:state',
      kind: 'custom',
      scope: { type: 'global' },
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            entityCui: input.entityCui,
            acceptedTermsAt: input.updatedAt,
          },
        },
      },
      result: null,
      updatedAt: input.updatedAt,
    },
    auditEvents: [],
    updatedSeq: '1',
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  };
}

function makeRow(input: {
  entityCui: string;
  values: CampaignEntityConfigValues;
  actorUserId: string;
  rowUpdatedAt: string;
}): LearningProgressRecordRow {
  const record = createCampaignEntityConfigRecord({
    campaignKey: 'funky',
    entityCui: input.entityCui,
    values: input.values,
    actorUserId: input.actorUserId,
    recordUpdatedAt: input.rowUpdatedAt,
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

function makeInvalidRow(): LearningProgressRecordRow {
  const row = makeRow({
    entityCui: '12345678',
    values: {
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: 'https://example.com/budget.pdf',
      public_debate: null,
    },
    actorUserId: 'admin-1',
    rowUpdatedAt: '2026-04-18T10:00:00.000Z',
  });

  return {
    ...row,
    record: {
      ...row.record,
      interactionId: 'funky:interaction:budget_document',
    },
  };
}

function toCampaignEntityConfigSortDto(
  row: LearningProgressRecordRow
): CampaignEntityConfigListItem {
  const entityCui = row.record.scope.type === 'entity' ? row.record.scope.entityCui : row.recordKey;

  return {
    campaignKey: 'funky',
    entityCui,
    entityName: null,
    usersCount: 0,
    isConfigured: true,
    values: {
      budgetPublicationDate: null,
      officialBudgetUrl: null,
      public_debate: null,
    },
    updatedAt: row.record.updatedAt,
    updatedByUserId: null,
  };
}

function ensureCampaignEntityConfigListCapableRepo(
  learningProgressRepo: LearningProgressRepository
): LearningProgressRepository {
  if (typeof learningProgressRepo.listCampaignEntityConfigRows === 'function') {
    return learningProgressRepo;
  }

  return {
    ...learningProgressRepo,
    async listCampaignEntityConfigRows(input) {
      const rowsResult = await learningProgressRepo.getRecords(input.userId, {
        includeInternal: true,
        recordKeyPrefix: input.recordKeyPrefix,
      });
      if (rowsResult.isErr()) {
        return rowsResult;
      }

      const filteredRows = rowsResult.value.filter((row) => {
        if (
          input.entityCui !== undefined &&
          row.recordKey !== buildCampaignEntityConfigRecordKey(input.entityCui)
        ) {
          return false;
        }

        if (
          input.updatedAtFrom !== undefined &&
          row.record.updatedAt.localeCompare(input.updatedAtFrom) < 0
        ) {
          return false;
        }

        if (
          input.updatedAtTo !== undefined &&
          row.record.updatedAt.localeCompare(input.updatedAtTo) > 0
        ) {
          return false;
        }

        return true;
      });

      const sortedRows = [...filteredRows].sort((left, right) =>
        compareCampaignEntityConfigDtos({
          left: toCampaignEntityConfigSortDto(left),
          right: toCampaignEntityConfigSortDto(right),
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        })
      );
      const cursorItem: CampaignEntityConfigListItem | null =
        input.cursor === undefined
          ? null
          : {
              campaignKey: 'funky',
              entityCui: input.cursor.entityCui,
              entityName: null,
              usersCount: 0,
              isConfigured: true,
              values: {
                budgetPublicationDate: null,
                officialBudgetUrl: null,
                public_debate: null,
              },
              updatedAt: input.cursor.updatedAt,
              updatedByUserId: null,
            };
      const pageStartIndex =
        cursorItem === null
          ? 0
          : sortedRows.findIndex((row) => {
              return (
                compareCampaignEntityConfigDtos({
                  left: toCampaignEntityConfigSortDto(row),
                  right: cursorItem,
                  sortBy: input.sortBy,
                  sortOrder: input.sortOrder,
                }) > 0
              );
            });
      const effectivePageStartIndex = pageStartIndex === -1 ? sortedRows.length : pageStartIndex;

      return ok({
        rows: sortedRows.slice(effectivePageStartIndex, effectivePageStartIndex + input.limit),
        totalCount: sortedRows.length,
        hasMore: effectivePageStartIndex + input.limit < sortedRows.length,
      });
    },
  };
}

async function createTestApp(options?: {
  permissionAllowed?: boolean;
  learningProgressRepo?: LearningProgressRepository;
  entityRepo?: EntityRepository;
  audienceReader?: ReturnType<typeof makeAudienceReader>;
}) {
  const testAuth = createTestAuthProvider();
  const app = fastifyLib({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    void reply.status(statusCode).send({
      ok: false,
      error: error.code ?? error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
      retryable: false,
    });
  });

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

  const permissionAuthorizer = {
    hasPermission: vi.fn(async () => options?.permissionAllowed ?? true),
  };
  const learningProgressRepo = ensureCampaignEntityConfigListCapableRepo(
    options?.learningProgressRepo ?? makeFakeLearningProgressRepo()
  );

  await app.register(
    makeCampaignEntityConfigRoutes({
      learningProgressRepo,
      entityRepo: options?.entityRepo ?? makeEntityRepo(['12345678']),
      audienceReader: options?.audienceReader ?? makeAudienceReader(),
      enabledCampaignKeys: ['funky'],
      permissionAuthorizer,
    })
  );

  await app.ready();
  return { app, testAuth, permissionAuthorizer };
}

describe('campaign entity config routes', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('returns 401 when unauthenticated', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 from the public route when unauthenticated', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/12345678/config',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns a public-safe payload for an authorized entity with only budget fields', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/budget.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
          [
            TEST_AUTH_USER_1,
            [
              makeAcceptedTermsRow({
                userId: TEST_AUTH_USER_1,
                entityCui: '12345678',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        campaignKey: 'funky',
        entityCui: '12345678',
        entityName: 'Alpha Town',
        isConfigured: true,
        values: {
          budgetPublicationDate: '2026-02-01',
          officialBudgetUrl: 'https://example.com/budget.pdf',
          public_debate: null,
        },
      },
    });
    expect(response.json().data).not.toHaveProperty('updatedAt');
    expect(response.json().data).not.toHaveProperty('updatedByUserId');
    expect(response.json().data).not.toHaveProperty('usersCount');
  });

  it('allows a public user with multiple entities to fetch each allowed entity explicitly', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '12345678', name: 'Alpha Town' },
        { cui: '87654321', name: 'Beta Commune' },
      ]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/alpha-budget.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: null,
                  officialBudgetUrl: 'https://example.com/beta-budget.pdf',
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                  },
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T13:00:00.000Z',
              }),
            ],
          ],
          [
            TEST_AUTH_USER_1,
            [
              makeAcceptedTermsRow({
                userId: TEST_AUTH_USER_1,
                entityCui: '12345678',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
              makeAcceptedTermsRow({
                userId: TEST_AUTH_USER_1,
                entityCui: '87654321',
                updatedAt: '2026-04-18T09:05:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const alphaResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });
    const betaResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/87654321/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(alphaResponse.statusCode).toBe(200);
    expect(alphaResponse.json().data).toMatchObject({
      entityCui: '12345678',
      entityName: 'Alpha Town',
      values: {
        budgetPublicationDate: '2026-02-01',
        officialBudgetUrl: 'https://example.com/alpha-budget.pdf',
        public_debate: null,
      },
    });

    expect(betaResponse.statusCode).toBe(200);
    expect(betaResponse.json().data).toMatchObject({
      entityCui: '87654321',
      entityName: 'Beta Commune',
      values: {
        budgetPublicationDate: null,
        officialBudgetUrl: 'https://example.com/beta-budget.pdf',
        public_debate: {
          date: '2026-05-10',
          time: '18:00',
          location: 'Council Hall',
          announcement_link: 'https://example.com/public-debate',
        },
      },
    });
  });

  it('returns full public debate fields when present', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/budget.pdf',
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                    online_participation_link: 'https://example.com/live',
                    description: 'Public debate regarding the local budget proposal.',
                  },
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
          [
            TEST_AUTH_USER_1,
            [
              makeAcceptedTermsRow({
                userId: TEST_AUTH_USER_1,
                entityCui: '12345678',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.values).toEqual({
      budgetPublicationDate: '2026-02-01',
      officialBudgetUrl: 'https://example.com/budget.pdf',
      public_debate: {
        date: '2026-05-10',
        time: '18:00',
        location: 'Council Hall',
        announcement_link: 'https://example.com/public-debate',
        online_participation_link: 'https://example.com/live',
        description: 'Public debate regarding the local budget proposal.',
      },
    });
  });

  it('returns partial optional public_debate fields when optional fields are omitted', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: null,
                  officialBudgetUrl: null,
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                  },
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
          [
            TEST_AUTH_USER_1,
            [
              makeAcceptedTermsRow({
                userId: TEST_AUTH_USER_1,
                entityCui: '12345678',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.values).toEqual({
      budgetPublicationDate: null,
      officialBudgetUrl: null,
      public_debate: {
        date: '2026-05-10',
        time: '18:00',
        location: 'Council Hall',
        announcement_link: 'https://example.com/public-debate',
      },
    });
  });

  it('returns the default public payload when the authorized entity has no configured config', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            TEST_AUTH_USER_1,
            [
              makeAcceptedTermsRow({
                userId: TEST_AUTH_USER_1,
                entityCui: '12345678',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        campaignKey: 'funky',
        entityCui: '12345678',
        entityName: 'Alpha Town',
        isConfigured: false,
        values: {
          budgetPublicationDate: null,
          officialBudgetUrl: null,
          public_debate: null,
        },
      },
    });
  });

  it('returns the same safe 404 for unauthorized existing and unauthorized missing entities', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([{ cui: '12345678', name: 'Alpha Town' }]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/budget.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const existingEntityResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });
    const missingEntityResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/campaigns/funky/entities/99999999/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(existingEntityResponse.statusCode).toBe(404);
    expect(missingEntityResponse.statusCode).toBe(404);
    expect(existingEntityResponse.json()).toEqual({
      ok: false,
      error: 'NotFoundError',
      message: 'Campaign entity config not found.',
      retryable: false,
    });
    expect(missingEntityResponse.json()).toEqual(existingEntityResponse.json());
  });

  it('returns 403 when permission is denied', async () => {
    const setup = await createTestApp({
      permissionAllowed: false,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ForbiddenError',
      message: 'You do not have permission to access this campaign entity config admin',
      retryable: false,
    });
  });

  it('returns 404 for unsupported campaigns', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/entity-config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns the default dto when the entity exists and no config row has been stored', async () => {
    const getByIdCalls: string[] = [];
    const setup = await createTestApp({
      entityRepo: makeEntityRepo(['12345678'], {
        onGetById(cui) {
          getByIdCalls.push(cui);
        },
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        campaignKey: 'funky',
        entityCui: '12345678',
        entityName: 'Entity 12345678',
        isConfigured: false,
        values: {
          budgetPublicationDate: null,
          officialBudgetUrl: null,
          public_debate: null,
        },
        updatedAt: null,
        updatedByUserId: null,
      },
    });
    expect(getByIdCalls).toEqual(['12345678']);
  });

  it('normalizes blank entity names on default detail responses', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([{ cui: '12345678', name: '   ' }]),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        campaignKey: 'funky',
        entityCui: '12345678',
        entityName: null,
        isConfigured: false,
        values: {
          budgetPublicationDate: null,
          officialBudgetUrl: null,
          public_debate: null,
        },
        updatedAt: null,
        updatedByUserId: null,
      },
    });
  });

  it('returns 404 when the entity does not exist', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([]),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for all-null replacement writes', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        expectedUpdatedAt: null,
        values: {
          budgetPublicationDate: null,
          officialBudgetUrl: null,
          public_debate: null,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'At least one campaign entity config value must be configured.',
      retryable: false,
    });
  });

  it('returns 409 for stale writes after a successful update', async () => {
    const repo = makeFakeLearningProgressRepo();
    const getByIdCalls: string[] = [];
    const setup = await createTestApp({
      learningProgressRepo: repo,
      entityRepo: makeEntityRepo(['12345678'], {
        onGetById(cui) {
          getByIdCalls.push(cui);
        },
      }),
    });
    app = setup.app;

    const firstResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        expectedUpdatedAt: null,
        values: {
          budgetPublicationDate: '2026-02-01',
          officialBudgetUrl: 'https://example.com/budget.pdf',
          public_debate: null,
        },
      },
    });

    const firstBody = firstResponse.json();
    expect(firstResponse.statusCode).toBe(200);
    expect(firstBody).toMatchObject({
      data: {
        entityCui: '12345678',
        entityName: 'Entity 12345678',
      },
    });

    const staleResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        values: {
          budgetPublicationDate: '2026-02-02',
          officialBudgetUrl: 'https://example.com/budget-v2.pdf',
          public_debate: null,
        },
      },
    });

    expect(staleResponse.statusCode).toBe(409);

    const secondResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        expectedUpdatedAt: firstBody.data.updatedAt,
        values: {
          budgetPublicationDate: '2026-02-03',
          officialBudgetUrl: 'https://example.com/budget-v3.pdf',
          public_debate: null,
        },
      },
    });

    const secondBody = secondResponse.json();
    expect(secondResponse.statusCode).toBe(200);
    expect(secondBody).toMatchObject({
      data: {
        entityCui: '12345678',
        entityName: 'Entity 12345678',
      },
    });
    expect(getByIdCalls).toEqual(['12345678', '12345678', '12345678']);
  });

  it('temporarily preserves stored public_debate when older PUT clients omit the field', async () => {
    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo(),
      entityRepo: makeEntityRepo(['12345678']),
    });
    app = setup.app;

    const createResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        expectedUpdatedAt: null,
        values: {
          budgetPublicationDate: null,
          officialBudgetUrl: 'https://example.com/budget.pdf',
          public_debate: {
            date: '2026-05-10',
            time: '18:00',
            location: 'Council Hall',
            announcement_link: 'https://example.com/public-debate',
          },
        },
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const createBody = createResponse.json();

    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        expectedUpdatedAt: createBody.data.updatedAt,
        values: {
          budgetPublicationDate: '2026-02-02',
          officialBudgetUrl: 'https://example.com/budget-v2.pdf',
        },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      ok: true,
      data: {
        values: {
          budgetPublicationDate: '2026-02-02',
          officialBudgetUrl: 'https://example.com/budget-v2.pdf',
          public_debate: {
            date: '2026-05-10',
            time: '18:00',
            location: 'Council Hall',
            announcement_link: 'https://example.com/public-debate',
          },
        },
      },
    });
  });

  it('treats whitespace-only optional public_debate urls as omitted on PUT', async () => {
    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo(),
      entityRepo: makeEntityRepo(['12345678']),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/campaigns/funky/entities/12345678/config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        expectedUpdatedAt: null,
        values: {
          budgetPublicationDate: null,
          officialBudgetUrl: 'https://example.com/budget.pdf',
          public_debate: {
            date: '2026-05-10',
            time: '18:00',
            location: 'Council Hall',
            announcement_link: 'https://example.com/public-debate',
            online_participation_link: '   ',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        values: {
          budgetPublicationDate: null,
          officialBudgetUrl: 'https://example.com/budget.pdf',
          public_debate: {
            date: '2026-05-10',
            time: '18:00',
            location: 'Council Hall',
            announcement_link: 'https://example.com/public-debate',
          },
        },
      },
    });
  });

  it('lists configured rows only with the canonical dto shape', async () => {
    const getByIdsCalls: string[][] = [];
    const setup = await createTestApp({
      entityRepo: makeEntityRepo(
        [
          { cui: '12345678', name: 'Alpha Town' },
          { cui: '87654321', name: 'Beta Commune' },
        ],
        {
          onGetByIds(cuis) {
            getByIdsCalls.push([...cuis]);
          },
        }
      ),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: '2026-02-02',
                  officialBudgetUrl: 'https://example.com/second.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T11:00:00.000Z',
              }),
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/first.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          {
            campaignKey: 'funky',
            entityCui: '12345678',
            entityName: 'Alpha Town',
            usersCount: 0,
            isConfigured: true,
            values: {
              budgetPublicationDate: '2026-02-01',
              officialBudgetUrl: 'https://example.com/first.pdf',
              public_debate: null,
            },
            updatedAt: '2026-04-18T12:00:00.000Z',
            updatedByUserId: 'admin-1',
          },
          {
            campaignKey: 'funky',
            entityCui: '87654321',
            entityName: 'Beta Commune',
            usersCount: 0,
            isConfigured: true,
            values: {
              budgetPublicationDate: '2026-02-02',
              officialBudgetUrl: 'https://example.com/second.pdf',
              public_debate: null,
            },
            updatedAt: '2026-04-18T11:00:00.000Z',
            updatedByUserId: 'admin-2',
          },
        ],
        page: {
          limit: 50,
          totalCount: 2,
          hasMore: false,
          nextCursor: null,
          sortBy: 'updatedAt',
          sortOrder: 'desc',
        },
      },
    });
    expect(getByIdsCalls).toHaveLength(1);
    expect(getByIdsCalls[0]).toHaveLength(2);
    expect(getByIdsCalls[0]).toEqual(expect.arrayContaining(['12345678', '87654321']));
  });

  it('filters configured rows by hasPublicDebate', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '12345678', name: 'Alpha Town' },
        { cui: '87654321', name: 'Beta Commune' },
      ]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: null,
                  officialBudgetUrl: 'https://example.com/first.pdf',
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                  },
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: '2026-02-02',
                  officialBudgetUrl: 'https://example.com/second.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T11:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config?hasPublicDebate=true&sortBy=entityCui&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(1);
    expect(response.json().data.items[0]).toMatchObject({
      entityCui: '12345678',
      values: {
        public_debate: {
          date: '2026-05-10',
          time: '18:00',
          location: 'Council Hall',
          announcement_link: 'https://example.com/public-debate',
        },
      },
    });
  });

  it('lists the union of configured rows and subscriber-backed default rows', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '12345678', name: 'Alpha Town' },
        { cui: '22222222', name: 'Beta Commune' },
      ]),
      audienceReader: makeAudienceReader(),
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
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                    online_participation_link: 'https://example.com/public-debate/live',
                    description: 'Public debate regarding the local budget proposal.',
                  },
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
          [
            'user-accepted-1',
            [
              makeAcceptedTermsRow({
                entityCui: '22222222',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config?sortBy=entityCui&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          {
            campaignKey: 'funky',
            entityCui: '12345678',
            entityName: 'Alpha Town',
            usersCount: 0,
            isConfigured: true,
            values: {
              budgetPublicationDate: '2026-02-01',
              officialBudgetUrl: 'https://example.com/first.pdf',
              public_debate: {
                date: '2026-05-10',
                time: '18:00',
                location: 'Council Hall',
                announcement_link: 'https://example.com/public-debate',
                online_participation_link: 'https://example.com/public-debate/live',
                description: 'Public debate regarding the local budget proposal.',
              },
            },
            updatedAt: '2026-04-18T12:00:00.000Z',
            updatedByUserId: 'admin-1',
          },
          {
            campaignKey: 'funky',
            entityCui: '22222222',
            entityName: 'Beta Commune',
            usersCount: 1,
            isConfigured: false,
            values: {
              budgetPublicationDate: null,
              officialBudgetUrl: null,
              public_debate: null,
            },
            updatedAt: null,
            updatedByUserId: null,
          },
        ],
        page: {
          limit: 50,
          totalCount: 2,
          hasMore: false,
          nextCursor: null,
          sortBy: 'entityCui',
          sortOrder: 'asc',
        },
      },
    });
  });

  it('returns config rows even when entity-name enrichment fails', async () => {
    const setup = await createTestApp({
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
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                    online_participation_link: 'https://example.com/public-debate/live',
                    description: 'Public debate regarding the local budget proposal.',
                  },
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          {
            campaignKey: 'funky',
            entityCui: '12345678',
            entityName: null,
            usersCount: 0,
            isConfigured: true,
            values: {
              budgetPublicationDate: '2026-02-01',
              officialBudgetUrl: 'https://example.com/first.pdf',
              public_debate: {
                date: '2026-05-10',
                time: '18:00',
                location: 'Council Hall',
                announcement_link: 'https://example.com/public-debate',
                online_participation_link: 'https://example.com/public-debate/live',
                description: 'Public debate regarding the local budget proposal.',
              },
            },
            updatedAt: '2026-04-18T12:00:00.000Z',
            updatedByUserId: 'admin-1',
          },
        ],
        page: {
          limit: 50,
          totalCount: 1,
          hasMore: false,
          nextCursor: null,
          sortBy: 'updatedAt',
          sortOrder: 'desc',
        },
      },
    });
  });

  it('returns 400 when a query filter is used on paginated listing', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '87654321', name: 'Beta Commune' },
        { cui: '12345678', name: 'Alpha Town' },
      ]),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: '2026-02-02',
                  officialBudgetUrl: 'https://example.com/second.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T11:00:00.000Z',
              }),
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/first.pdf',
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                    online_participation_link: 'https://example.com/public-debate/live',
                    description: 'Public debate regarding the local budget proposal.',
                  },
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config?query=alpha&sortBy=entityCui&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'FST_ERR_VALIDATION',
      message: 'querystring/query must NOT have more than 0 characters',
      retryable: false,
    });
  });

  it('returns 400 for an invalid collection cursor', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config?cursor=not-base64',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign entity config cursor',
      retryable: false,
    });
  });

  it('filters and sorts collection rows by payload fields', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '12345678', name: 'Alpha Town' },
        { cui: '87654321', name: 'Beta Commune' },
        { cui: '99999999', name: 'Gamma Village' },
      ]),
      audienceReader: makeAudienceReader(),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: '2026-02-02',
                  officialBudgetUrl: 'https://example.com/second.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T11:00:00.000Z',
              }),
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-03-01',
                  officialBudgetUrl: 'https://example.com/first.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
          [
            'user-accepted-1',
            [
              makeAcceptedTermsRow({
                entityCui: '99999999',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const sortedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config?sortBy=budgetPublicationDate&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(sortedResponse.statusCode).toBe(200);
    const sortedBody: {
      data: {
        items: { entityCui: string }[];
      };
    } = sortedResponse.json();
    expect(sortedBody.data.items.map((item) => item.entityCui)).toEqual([
      '99999999',
      '87654321',
      '12345678',
    ]);

    const filteredResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config?hasOfficialBudgetUrl=false',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(filteredResponse.statusCode).toBe(200);
    expect(filteredResponse.json()).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            entityCui: '99999999',
            isConfigured: false,
          },
        ],
      },
    });
  });

  it('returns 500 when a persisted config row is corrupted', async () => {
    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([[buildCampaignEntityConfigUserId('funky'), [makeInvalidRow()]]]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'DatabaseError',
      message: 'Invalid persisted campaign entity config row.',
      retryable: false,
    });
  });

  it('streams a csv export with the same configured-or-subscribed union scope as the list route', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '12345678', name: 'Alpha Town' },
        { cui: '87654321', name: 'Beta Commune' },
        { cui: '99999999', name: '=Unconfigured Village' },
        { cui: '55555555', name: 'Ignored Borough' },
      ]),
      audienceReader: makeAudienceReader(),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: '2026-02-02',
                  officialBudgetUrl: 'https://example.com/second.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T11:00:00.000Z',
              }),
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/first.pdf',
                  public_debate: {
                    date: '2026-05-10',
                    time: '18:00',
                    location: 'Council Hall',
                    announcement_link: 'https://example.com/public-debate',
                    online_participation_link: 'https://example.com/public-debate/live',
                    description: 'Public debate regarding the local budget proposal.',
                  },
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
          [
            'user-accepted-1',
            [
              makeAcceptedTermsRow({
                entityCui: '99999999',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config/export?sortBy=entityCui&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        origin: 'http://localhost:3001',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain(
      'funky-campaign-entity-config-export-'
    );
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');

    const csvBody = response.body.startsWith('\uFEFF') ? response.body.slice(1) : response.body;
    const csvLines = csvBody.trimEnd().split('\n');

    expect(csvLines).toHaveLength(4);
    expect(csvLines[0]).toContain(
      'Campaign Key,Entity CUI,Entity Name,Users,Configured,budgetPublicationDate,officialBudgetUrl,public_debate.date,public_debate.time,public_debate.location,public_debate.online_participation_link,public_debate.announcement_link,public_debate.description'
    );
    expect(csvBody).toContain(
      'funky,12345678,Alpha Town,0,true,2026-02-01,https://example.com/first.pdf,2026-05-10,18:00,Council Hall,https://example.com/public-debate/live,https://example.com/public-debate,Public debate regarding the local budget proposal.'
    );
    expect(csvBody).toContain(
      'funky,87654321,Beta Commune,0,true,2026-02-02,https://example.com/second.pdf,,,,,,'
    );
    expect(csvBody).toContain("funky,99999999,'=Unconfigured Village,1,false,,,,,,,,");
    expect(csvBody).not.toContain('Ignored Borough');
  });

  it('exports the merged collection without scanning the full entity repository', async () => {
    const getAllCalls: {
      filter: EntityFilter;
      limit: number;
      offset: number;
    }[] = [];
    const entities = Array.from({ length: 1001 }, (_, index) => {
      const cui = String(10000000 + index);

      return {
        cui,
        name: `Entity ${cui}`,
      };
    });
    const finalEntityCui = entities[1000]?.cui ?? '10001000';
    const setup = await createTestApp({
      entityRepo: makeEntityRepo(entities, {
        onGetAll(input) {
          getAllCalls.push(input);
        },
      }),
      audienceReader: makeAudienceReader(),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: finalEntityCui,
                values: {
                  budgetPublicationDate: '2026-03-01',
                  officialBudgetUrl: 'https://example.com/final.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-final',
                rowUpdatedAt: '2026-04-18T13:00:00.000Z',
              }),
            ],
          ],
          [
            'user-accepted-1',
            [
              makeAcceptedTermsRow({
                entityCui: entities[0]?.cui ?? '10000000',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config/export',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getAllCalls).toEqual([]);

    const csvBody = response.body.startsWith('\uFEFF') ? response.body.slice(1) : response.body;
    const csvLines = csvBody.trimEnd().split('\n');
    const firstEntityCui = entities[0]?.cui ?? '10000000';

    expect(csvLines).toHaveLength(3);
    expect(csvBody).toContain(`funky,${firstEntityCui},Entity ${firstEntityCui},1,false,,,,`);
    expect(csvBody).toContain(
      `funky,${finalEntityCui},Entity ${finalEntityCui},0,true,2026-03-01,https://example.com/final.pdf`
    );
  });

  it('filters export rows by query while preserving entityCui-ordered streaming', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '12345678', name: 'Alpha Town' },
        { cui: '87654321', name: 'Beta Commune' },
        { cui: '99999999', name: 'Gamma Village' },
      ]),
      audienceReader: makeAudienceReader(),
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
                  public_debate: null,
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: '2026-02-02',
                  officialBudgetUrl: 'https://example.com/second.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T11:00:00.000Z',
              }),
            ],
          ],
          [
            'user-accepted-1',
            [
              makeAcceptedTermsRow({
                entityCui: '99999999',
                updatedAt: '2026-04-18T09:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config/export?query=ma',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);

    const csvBody = response.body.startsWith('\uFEFF') ? response.body.slice(1) : response.body;
    const csvLines = csvBody.trimEnd().split('\n');

    expect(csvLines).toHaveLength(2);
    expect(csvBody).toContain('funky,99999999,Gamma Village,1,false,,,,');
    expect(csvBody).not.toContain('Alpha Town');
    expect(csvBody).not.toContain('Beta Commune');
  });

  it('ignores export sort params that differ from the internal streaming order', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepo([
        { cui: '12345678', name: 'Alpha Town' },
        { cui: '87654321', name: 'Beta Commune' },
      ]),
      audienceReader: makeAudienceReader(),
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            buildCampaignEntityConfigUserId('funky'),
            [
              makeRow({
                entityCui: '87654321',
                values: {
                  budgetPublicationDate: '2026-02-02',
                  officialBudgetUrl: 'https://example.com/second.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-2',
                rowUpdatedAt: '2026-04-18T11:00:00.000Z',
              }),
              makeRow({
                entityCui: '12345678',
                values: {
                  budgetPublicationDate: '2026-02-01',
                  officialBudgetUrl: 'https://example.com/first.pdf',
                  public_debate: null,
                },
                actorUserId: 'admin-1',
                rowUpdatedAt: '2026-04-18T12:00:00.000Z',
              }),
            ],
          ],
        ]),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entity-config/export?sortBy=updatedAt&sortOrder=desc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);

    const csvBody = response.body.startsWith('\uFEFF') ? response.body.slice(1) : response.body;
    const csvLines = csvBody.trimEnd().split('\n');

    expect(csvLines).toHaveLength(3);
    expect(csvLines[1]).toContain('funky,12345678,Alpha Town');
    expect(csvLines[2]).toContain('funky,87654321,Beta Commune');
  });
});
