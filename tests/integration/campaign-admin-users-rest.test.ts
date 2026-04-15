import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS } from '@/common/campaign-user-interactions.js';
import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import { type EntityProfileRepository, type EntityRepository } from '@/modules/entity/index.js';
import {
  makeCampaignAdminUserInteractionRoutes,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

interface CampaignAdminUsersResponsePage {
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly sortBy?: string;
  readonly sortOrder?: string;
}

interface CampaignAdminUsersResponseItem {
  readonly userId: string;
}

interface CampaignAdminUsersResponseBody<TItem> {
  readonly ok: boolean;
  readonly data: {
    readonly items: TItem[];
    readonly page: CampaignAdminUsersResponsePage;
  };
}

function makeRow(
  userId: string,
  record: LearningProgressRecordRow['record'],
  updatedSeq: string
): LearningProgressRecordRow {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  };
}

function createDebateRequestRecord(input: {
  entityCui: string;
  updatedAt: string;
  submissionPath?: 'request_platform' | 'send_yourself';
  phase?: 'pending' | 'resolved' | 'failed';
  reviewStatus?: 'approved' | 'rejected';
}) {
  const record = createTestInteractiveRecord({
    key: `funky:interaction:public_debate_request::entity:${input.entityCui}`,
    interactionId: 'funky:interaction:public_debate_request',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui: input.entityCui },
    phase: input.phase ?? 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          primariaEmail: 'contact@primarie.ro',
          organizationName: 'Asociatia Test',
          legalRepresentativeName: 'Sensitive Person',
          preparedSubject: 'Sensitive Subject',
          submissionPath: input.submissionPath ?? 'request_platform',
          submittedAt: input.updatedAt,
        },
      },
    },
    result: null,
    updatedAt: input.updatedAt,
    submittedAt: input.updatedAt,
  });

  if (input.reviewStatus === undefined) {
    return record;
  }

  return {
    ...record,
    review: {
      status: input.reviewStatus,
      reviewedAt: input.updatedAt,
      reviewedByUserId: 'reviewer-1',
      reviewSource: 'campaign_admin_api' as const,
    },
  };
}

function createCityHallWebsiteRecord(input: {
  entityCui: string;
  updatedAt: string;
  phase?: 'pending' | 'resolved' | 'failed';
  reviewStatus?: 'approved' | 'rejected';
}) {
  const record = createTestInteractiveRecord({
    key: `funky:interaction:city_hall_website::entity:${input.entityCui}`,
    interactionId: 'funky:interaction:city_hall_website',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui: input.entityCui },
    phase: input.phase ?? 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          websiteUrl: `https://primarie-${input.entityCui}.test`,
          submittedAt: input.updatedAt,
        },
      },
    },
    result: null,
    updatedAt: input.updatedAt,
    submittedAt: input.updatedAt,
  });

  if (input.reviewStatus === undefined) {
    return record;
  }

  return {
    ...record,
    review: {
      status: input.reviewStatus,
      reviewedAt: input.updatedAt,
      reviewedByUserId: 'reviewer-1',
      reviewSource: 'campaign_admin_api' as const,
    },
  };
}

function createParticipationReportRecord(input: {
  entityCui: string;
  updatedAt: string;
  phase?: 'pending' | 'resolved';
}) {
  return createTestInteractiveRecord({
    key: `funky:interaction:funky_participation::entity:${input.entityCui}`,
    interactionId: 'funky:interaction:funky_participation',
    lessonId: 'civic-participate-and-act',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui: input.entityCui },
    phase: input.phase ?? 'resolved',
    value: {
      kind: 'json',
      json: {
        value: {
          debateTookPlace: 'yes',
          approximateAttendees: 42,
          submittedAt: input.updatedAt,
        },
      },
    },
    result: null,
    updatedAt: input.updatedAt,
    submittedAt: input.updatedAt,
  });
}

function createQuizRecord(input: { interactionId: string; updatedAt: string }) {
  return createTestInteractiveRecord({
    interactionId: input.interactionId,
    lessonId: 'civic-campaign-quiz',
    scope: { type: 'global' },
    phase: 'resolved',
    updatedAt: input.updatedAt,
    submittedAt: input.updatedAt,
  });
}

function createAcceptedTermsRecord(input: { entityCui: string; updatedAt: string }) {
  return createTestInteractiveRecord({
    key: `funky:progress:terms_accepted::entity:${input.entityCui}`,
    interactionId: `funky:progress:terms_accepted::entity:${input.entityCui}`,
    lessonId: 'funky:progress:state',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'global' },
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
    submittedAt: input.updatedAt,
  });
}

function withAcceptedTermsRows(
  initialRecords: Map<string, LearningProgressRecordRow[]>
): Map<string, LearningProgressRecordRow[]> {
  const nextRecords = new Map<string, LearningProgressRecordRow[]>();

  for (const [userId, rows] of initialRecords.entries()) {
    const latestAcceptedTermsByEntity = new Map<string, string>();
    const existingTermsKeys = new Set(
      rows
        .filter((row) => row.recordKey.startsWith('funky:progress:terms_accepted::entity:'))
        .map((row) => row.recordKey)
    );

    for (const row of rows) {
      if (row.record.scope.type !== 'entity') {
        continue;
      }

      const previousUpdatedAt = latestAcceptedTermsByEntity.get(row.record.scope.entityCui);
      if (
        previousUpdatedAt === undefined ||
        Date.parse(row.updatedAt) > Date.parse(previousUpdatedAt)
      ) {
        latestAcceptedTermsByEntity.set(row.record.scope.entityCui, row.updatedAt);
      }
    }

    const acceptedTermsRows = [...latestAcceptedTermsByEntity.entries()].flatMap(
      ([entityCui, updatedAt], index) => {
        const record = createAcceptedTermsRecord({ entityCui, updatedAt });
        if (existingTermsKeys.has(record.key)) {
          return [];
        }

        return [makeRow(userId, record, String(rows.length + index + 1))];
      }
    );

    nextRecords.set(userId, [...rows, ...acceptedTermsRows]);
  }

  return nextRecords;
}

function makeTestEntityRepo(entityNames: Record<string, string>): EntityRepository {
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

function makeTestEntityProfileRepo(): EntityProfileRepository {
  return {
    async getByEntityCui() {
      return ok(null);
    },
    async getByEntityCuis() {
      return ok(new Map());
    },
  };
}

async function createTestApp(options?: {
  learningProgressRepo?: LearningProgressRepository;
  permissionAllowed?: boolean;
  entityRepo?: EntityRepository;
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

  await app.register(
    makeCampaignAdminUserInteractionRoutes({
      learningProgressRepo: options?.learningProgressRepo ?? makeFakeLearningProgressRepo(),
      entityRepo: options?.entityRepo ?? makeTestEntityRepo({}),
      entityProfileRepo: makeTestEntityProfileRepo(),
      enabledCampaignKeys: ['funky'],
      permissionAuthorizer,
    })
  );

  await app.ready();
  return { app, testAuth, permissionAuthorizer };
}

describe('Campaign Admin Users REST API', () => {
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

  it('returns 401 when authentication is missing', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 403 when the authenticated user lacks campaign-admin permission', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const listUsersSpy = vi.spyOn(learningProgressRepo, 'listCampaignAdminUsers');
    const setup = await createTestApp({
      permissionAllowed: false,
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ForbiddenError',
      message: 'You do not have permission to access this campaign interaction audit',
      retryable: false,
    });
    expect(setup.permissionAuthorizer.hasPermission).toHaveBeenCalledWith({
      userId: 'user_test_1',
      permissionName: 'campaign:funky_admin',
    });
    expect(listUsersSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for users meta when authentication is missing', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const metaSpy = vi.spyOn(learningProgressRepo, 'getCampaignAdminUsersMetaCounts');
    const setup = await createTestApp({
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users/meta',
    });

    expect(response.statusCode).toBe(401);
    expect(metaSpy).not.toHaveBeenCalled();
  });

  it('returns 403 for users meta when the authenticated user lacks campaign-admin permission', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const metaSpy = vi.spyOn(learningProgressRepo, 'getCampaignAdminUsersMetaCounts');
    const setup = await createTestApp({
      permissionAllowed: false,
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(metaSpy).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown campaigns', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/users',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for unknown campaigns on users meta', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const metaSpy = vi.spyOn(learningProgressRepo, 'getCampaignAdminUsersMetaCounts');
    const setup = await createTestApp({
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/users/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(metaSpy).not.toHaveBeenCalled();
  });

  it('returns an empty 200 response with default paging metadata', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [],
        page: {
          totalCount: 0,
          hasMore: false,
          nextCursor: null,
          sortBy: 'latestUpdatedAt',
          sortOrder: 'desc',
        },
      },
    });
  });

  it('returns zero-count users meta responses', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const setup = await createTestApp({
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        totalUsers: 0,
        usersWithPendingReviews: 0,
      },
    });
  });

  it('passes only campaign-derived interaction filters to the users meta repo', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const metaSpy = vi.spyOn(learningProgressRepo, 'getCampaignAdminUsersMetaCounts');
    const setup = await createTestApp({
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(metaSpy).toHaveBeenCalledWith({
      campaignKey: 'funky',
      interactions: expect.arrayContaining([
        { interactionId: 'funky:interaction:public_debate_request' },
        { interactionId: 'funky:interaction:city_hall_website' },
        { interactionId: 'funky:interaction:funky_participation' },
      ]),
      reviewableInteractions: expect.arrayContaining([
        {
          interactionId: 'funky:interaction:public_debate_request',
          submissionPath: 'request_platform',
        },
        { interactionId: 'funky:interaction:city_hall_website' },
      ]),
    });
    expect(metaSpy).toHaveBeenCalledTimes(1);
  });

  it('aggregates campaign users across multiple rows and keeps pendingReviewCount reviewable-only', async () => {
    const requestPlatformRecord = createDebateRequestRecord({
      entityCui: '11111111',
      updatedAt: '2026-04-10T10:00:00.000Z',
      submissionPath: 'request_platform',
      phase: 'pending',
    });
    const sendYourselfRecord = createDebateRequestRecord({
      entityCui: '22222222',
      updatedAt: '2026-04-10T11:00:00.000Z',
      submissionPath: 'send_yourself',
      phase: 'pending',
    });
    const participationRecord = createParticipationReportRecord({
      entityCui: '33333333',
      updatedAt: '2026-04-10T09:00:00.000Z',
      phase: 'resolved',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-aggregate', [
      makeRow('user-aggregate', requestPlatformRecord, '1'),
      makeRow('user-aggregate', sendYourselfRecord, '2'),
      makeRow('user-aggregate', participationRecord, '3'),
    ]);

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: withAcceptedTermsRows(initialRecords),
      }),
      entityRepo: makeTestEntityRepo({
        '11111111': 'Primaria One',
        '22222222': 'Primaria Two',
        '33333333': 'Primaria Three',
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<CampaignAdminUsersResponseBody<Record<string, unknown>>>();

    expect(body.ok).toBe(true);
    expect(body.data.page).toEqual({
      totalCount: 1,
      hasMore: false,
      nextCursor: null,
      sortBy: 'latestUpdatedAt',
      sortOrder: 'desc',
    });
    expect(body.data.items).toEqual([
      {
        userId: 'user-aggregate',
        interactionCount: 3,
        pendingReviewCount: 1,
        latestUpdatedAt: '2026-04-10T11:00:00.000Z',
        latestInteractionId: 'funky:interaction:public_debate_request',
        latestEntityCui: '22222222',
        latestEntityName: 'Primaria Two',
      },
    ]);
    expect(Object.keys(body.data.items[0] ?? {}).sort()).toEqual([
      'interactionCount',
      'latestEntityCui',
      'latestEntityName',
      'latestInteractionId',
      'latestUpdatedAt',
      'pendingReviewCount',
      'userId',
    ]);
  });

  it('returns campaign users meta counts for a realistic dataset', async () => {
    const userOnePendingRecord = createDebateRequestRecord({
      entityCui: '11111111',
      updatedAt: '2026-04-10T10:00:00.000Z',
      submissionPath: 'request_platform',
      phase: 'pending',
    });
    const userOneNonReviewableRecord = createDebateRequestRecord({
      entityCui: '22222222',
      updatedAt: '2026-04-10T11:00:00.000Z',
      submissionPath: 'send_yourself',
      phase: 'pending',
    });
    const userTwoResolvedRecord = createCityHallWebsiteRecord({
      entityCui: '33333333',
      updatedAt: '2026-04-10T12:00:00.000Z',
      phase: 'resolved',
      reviewStatus: 'approved',
    });
    const userThreeParticipationRecord = createParticipationReportRecord({
      entityCui: '44444444',
      updatedAt: '2026-04-10T13:00:00.000Z',
      phase: 'resolved',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-meta-1', [
      makeRow('user-meta-1', userOnePendingRecord, '1'),
      makeRow('user-meta-1', userOneNonReviewableRecord, '2'),
    ]);
    initialRecords.set('user-meta-2', [makeRow('user-meta-2', userTwoResolvedRecord, '3')]);
    initialRecords.set('user-meta-3', [makeRow('user-meta-3', userThreeParticipationRecord, '4')]);

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: withAcceptedTermsRows(initialRecords),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        totalUsers: 3,
        usersWithPendingReviews: 1,
      },
    });
  });

  it('includes users with global-only admin-visible interactions', async () => {
    const quizRecord = createQuizRecord({
      interactionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[0],
      updatedAt: '2026-04-10T14:00:00.000Z',
    });
    const debateRequestRecord = createDebateRequestRecord({
      entityCui: '12345678',
      updatedAt: '2026-04-10T12:00:00.000Z',
      submissionPath: 'request_platform',
      phase: 'pending',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-quiz-only', [makeRow('user-quiz-only', quizRecord, '1')]);
    initialRecords.set('user-entity', [makeRow('user-entity', debateRequestRecord, '2')]);

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: withAcceptedTermsRows(initialRecords),
      }),
      entityRepo: makeTestEntityRepo({
        '12345678': 'Primaria One',
      }),
    });
    app = setup.app;

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({
      ok: true,
      data: {
        items: [
          {
            userId: 'user-quiz-only',
            interactionCount: 1,
            pendingReviewCount: 0,
            latestUpdatedAt: '2026-04-10T14:00:00.000Z',
            latestInteractionId: CIVIC_CAMPAIGN_QUIZ_INTERACTION_IDS[0],
            latestEntityCui: null,
            latestEntityName: null,
          },
          {
            userId: 'user-entity',
            interactionCount: 1,
            pendingReviewCount: 1,
            latestUpdatedAt: '2026-04-10T12:00:00.000Z',
            latestInteractionId: 'funky:interaction:public_debate_request',
            latestEntityCui: '12345678',
            latestEntityName: 'Primaria One',
          },
        ],
        page: {
          totalCount: 2,
          hasMore: false,
          nextCursor: null,
          sortBy: 'latestUpdatedAt',
          sortOrder: 'desc',
        },
      },
    });

    const metaResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(metaResponse.statusCode).toBe(200);
    expect(metaResponse.json()).toEqual({
      ok: true,
      data: {
        totalUsers: 2,
        usersWithPendingReviews: 1,
      },
    });
  });

  it('passes entityCui through to the users repo and allows subscription-only rows', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const listUsersSpy = vi.spyOn(learningProgressRepo, 'listCampaignAdminUsers').mockResolvedValue(
      ok({
        items: [
          {
            userId: 'subscriber-only',
            interactionCount: 0,
            pendingReviewCount: 0,
            latestUpdatedAt: '2026-04-10T14:00:00.000Z',
            latestInteractionId: null,
            latestEntityCui: '12345678',
          },
        ],
        totalCount: 1,
        hasMore: false,
        nextCursor: null,
      })
    );
    const setup = await createTestApp({
      learningProgressRepo,
      entityRepo: makeTestEntityRepo({
        '12345678': 'Primaria One',
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?entityCui=12345678',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(listUsersSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignKey: 'funky',
        entityCui: '12345678',
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
      })
    );
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          {
            userId: 'subscriber-only',
            interactionCount: 0,
            pendingReviewCount: 0,
            latestUpdatedAt: '2026-04-10T14:00:00.000Z',
            latestInteractionId: null,
            latestEntityCui: '12345678',
            latestEntityName: 'Primaria One',
          },
        ],
        page: {
          totalCount: 1,
          hasMore: false,
          nextCursor: null,
          sortBy: 'latestUpdatedAt',
          sortOrder: 'desc',
        },
      },
    });
  });

  it('supports sorting by each supported user aggregate key', async () => {
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-beta', [
      makeRow(
        'user-beta',
        createDebateRequestRecord({
          entityCui: '10000001',
          updatedAt: '2026-04-10T09:00:00.000Z',
          submissionPath: 'request_platform',
          phase: 'pending',
        }),
        '1'
      ),
      makeRow(
        'user-beta',
        createDebateRequestRecord({
          entityCui: '10000002',
          updatedAt: '2026-04-10T07:00:00.000Z',
          submissionPath: 'send_yourself',
          phase: 'pending',
        }),
        '2'
      ),
    ]);
    initialRecords.set('user-alpha', [
      makeRow(
        'user-alpha',
        createParticipationReportRecord({
          entityCui: '10000003',
          updatedAt: '2026-04-10T10:00:00.000Z',
          phase: 'resolved',
        }),
        '3'
      ),
    ]);
    initialRecords.set('user-gamma', [
      makeRow(
        'user-gamma',
        createDebateRequestRecord({
          entityCui: '10000004',
          updatedAt: '2026-04-10T08:00:00.000Z',
          submissionPath: 'request_platform',
          phase: 'pending',
        }),
        '4'
      ),
      makeRow(
        'user-gamma',
        createCityHallWebsiteRecord({
          entityCui: '10000005',
          updatedAt: '2026-04-10T06:00:00.000Z',
          phase: 'pending',
        }),
        '5'
      ),
      makeRow(
        'user-gamma',
        createDebateRequestRecord({
          entityCui: '10000006',
          updatedAt: '2026-04-10T05:00:00.000Z',
          submissionPath: 'request_platform',
          phase: 'pending',
        }),
        '6'
      ),
    ]);

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: withAcceptedTermsRows(initialRecords),
      }),
    });
    app = setup.app;

    const latestUpdatedAtResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?sortBy=latestUpdatedAt&sortOrder=desc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });
    const userIdResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?sortBy=userId&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });
    const interactionCountResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?sortBy=interactionCount&sortOrder=desc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });
    const pendingReviewCountResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?sortBy=pendingReviewCount&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    const latestUpdatedAtBody =
      latestUpdatedAtResponse.json<
        CampaignAdminUsersResponseBody<CampaignAdminUsersResponseItem>
      >();
    const userIdBody =
      userIdResponse.json<CampaignAdminUsersResponseBody<CampaignAdminUsersResponseItem>>();
    const interactionCountBody =
      interactionCountResponse.json<
        CampaignAdminUsersResponseBody<CampaignAdminUsersResponseItem>
      >();
    const pendingReviewCountBody =
      pendingReviewCountResponse.json<
        CampaignAdminUsersResponseBody<CampaignAdminUsersResponseItem>
      >();

    expect(latestUpdatedAtBody.data.items.map((item) => item.userId)).toEqual([
      'user-alpha',
      'user-beta',
      'user-gamma',
    ]);
    expect(userIdBody.data.items.map((item) => item.userId)).toEqual([
      'user-alpha',
      'user-beta',
      'user-gamma',
    ]);
    expect(interactionCountBody.data.items.map((item) => item.userId)).toEqual([
      'user-gamma',
      'user-beta',
      'user-alpha',
    ]);
    expect(pendingReviewCountBody.data.items.map((item) => item.userId)).toEqual([
      'user-alpha',
      'user-beta',
      'user-gamma',
    ]);
  });

  it('supports cursor pagination across aggregated user rows', async () => {
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-3', [
      makeRow(
        'user-3',
        createParticipationReportRecord({
          entityCui: '20000003',
          updatedAt: '2026-04-10T12:00:00.000Z',
          phase: 'resolved',
        }),
        '1'
      ),
    ]);
    initialRecords.set('user-2', [
      makeRow(
        'user-2',
        createCityHallWebsiteRecord({
          entityCui: '20000002',
          updatedAt: '2026-04-10T11:00:00.000Z',
          phase: 'pending',
        }),
        '2'
      ),
    ]);
    initialRecords.set('user-1', [
      makeRow(
        'user-1',
        createDebateRequestRecord({
          entityCui: '20000001',
          updatedAt: '2026-04-10T10:00:00.000Z',
          submissionPath: 'request_platform',
          phase: 'pending',
        }),
        '3'
      ),
    ]);

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: withAcceptedTermsRows(initialRecords),
      }),
    });
    app = setup.app;

    const firstResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?sortBy=latestUpdatedAt&sortOrder=desc&limit=2',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    const firstBody =
      firstResponse.json<CampaignAdminUsersResponseBody<CampaignAdminUsersResponseItem>>();
    expect(firstBody.data.items.map((item) => item.userId)).toEqual(['user-3', 'user-2']);
    expect(firstBody.data.page.hasMore).toBe(true);
    expect(firstBody.data.page.nextCursor).not.toBeNull();

    const secondResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/users?sortBy=latestUpdatedAt&sortOrder=desc&limit=2&cursor=${encodeURIComponent(firstBody.data.page.nextCursor ?? '')}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    const secondBody =
      secondResponse.json<CampaignAdminUsersResponseBody<CampaignAdminUsersResponseItem>>();
    expect(secondBody.data.items.map((item) => item.userId)).toEqual(['user-1']);
  });

  it('filters by trimmed userId query text', async () => {
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('alpha-user', [
      makeRow(
        'alpha-user',
        createParticipationReportRecord({
          entityCui: '30000001',
          updatedAt: '2026-04-10T10:00:00.000Z',
        }),
        '1'
      ),
    ]);
    initialRecords.set('beta-user', [
      makeRow(
        'beta-user',
        createParticipationReportRecord({
          entityCui: '30000002',
          updatedAt: '2026-04-10T09:00:00.000Z',
        }),
        '2'
      ),
    ]);

    const setup = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: withAcceptedTermsRows(initialRecords),
      }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?query=%20%20alpha%20%20',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<CampaignAdminUsersResponseBody<CampaignAdminUsersResponseItem>>();
    expect(body.data.items.map((item) => item.userId)).toEqual(['alpha-user']);
  });

  it('returns 400 for an invalid cursor', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?cursor=invalid',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign user cursor',
      retryable: false,
    });
  });

  it('returns 400 when cursor sort does not match the request sort', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const mismatchedCursor = Buffer.from(
      JSON.stringify({
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        userId: 'user-1',
        value: '2026-04-10T10:00:00.000Z',
      }),
      'utf-8'
    ).toString('base64url');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/users?sortBy=userId&sortOrder=asc&cursor=${encodeURIComponent(mismatchedCursor)}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign user cursor',
      retryable: false,
    });
  });

  it('returns 400 for a structured cursor with an invalid sort value', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const malformedCursor = Buffer.from(
      JSON.stringify({
        sortBy: 'latestUpdatedAt',
        sortOrder: 'desc',
        userId: 'user-1',
        value: 'not-a-timestamp',
      }),
      'utf-8'
    ).toString('base64url');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/users?cursor=${encodeURIComponent(malformedCursor)}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign user cursor',
      retryable: false,
    });
  });

  it('returns 400 for unsupported filters on the users list', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const listUsersSpy = vi.spyOn(learningProgressRepo, 'listCampaignAdminUsers');
    const setup = await createTestApp({
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?hasSubscribers=true',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(listUsersSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for unsupported user sorts', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const listUsersSpy = vi.spyOn(learningProgressRepo, 'listCampaignAdminUsers');
    const setup = await createTestApp({
      learningProgressRepo,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?sortBy=entityName',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(listUsersSpy).not.toHaveBeenCalled();
  });

  it('validates limit bounds', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/users?limit=0',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      retryable: false,
    });
  });
});
