import { randomUUID } from 'node:crypto';

import fastifyLib from 'fastify';
import { err, fromThrowable, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  createDatabaseError,
  makeCampaignAdminNotificationRoutes,
  makeCampaignNotificationOutboxAuditRepo,
  makeCampaignNotificationRunnableTemplateRegistry,
  makeCampaignNotificationTemplatePreviewService,
  makeCampaignNotificationTriggerRegistry,
  type CampaignNotificationAuditRepository,
  type CampaignNotificationAuditCursor,
  type CampaignNotificationMetaCounts,
  type CampaignNotificationRunnablePlanCreationInput,
  type CampaignNotificationRunnablePlanRepository,
  type CampaignNotificationStoredPlan,
  type ListCampaignNotificationAuditInput,
} from '@/modules/campaign-admin-notifications/index.js';
import { buildAdminReviewedInteractionDeliveryKey } from '@/modules/notification-delivery/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  sha256Hasher,
} from '@/modules/notifications/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../fixtures/fakes.js';
import { createPublicDebateNotificationHarness } from '../fixtures/public-debate-notification-harness.js';
import {
  createThreadAggregateRecord,
  createThreadRecord,
} from '../unit/institution-correspondence/fake-repo.js';

const logger = pinoLogger({ level: 'silent' });

const createAcceptedTermsRecord = (
  entityCui = '12345678',
  acceptedTermsAt = '2026-04-10T10:00:00.000Z'
) =>
  createTestInteractiveRecord({
    key: `funky:progress:terms_accepted::entity:${entityCui}`,
    interactionId: `funky:progress:terms_accepted::entity:${entityCui}`,
    lessonId: 'funky:progress:state',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'global' },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: {
          entityCui,
          acceptedTermsAt,
        },
      },
    },
    result: null,
    updatedAt: acceptedTermsAt,
    submittedAt: acceptedTermsAt,
  });

const createReviewedBudgetDocumentRecord = (
  entityCui = '12345678',
  reviewedAt = '2026-04-12T15:00:00.000Z'
) =>
  createTestInteractiveRecord({
    key: `test:${entityCui}:budget-document-reviewed`,
    interactionId: 'funky:interaction:budget_document',
    lessonId: 'lesson-budget-document',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'failed',
    value: {
      kind: 'json',
      json: {
        value: {
          documentUrl: 'https://example.invalid/buget.pdf',
          submittedAt: '2026-04-11T10:00:00.000Z',
        },
      },
    },
    review: {
      status: 'rejected',
      reviewedAt,
      feedbackText: 'Documentul trimis nu este suficient de clar.',
      reviewedByUserId: 'admin-user',
      reviewSource: 'campaign_admin_api',
    },
    updatedAt: reviewedAt,
    submittedAt: '2026-04-11T10:00:00.000Z',
  });

const createApprovedPublicDebateRequestRecord = (
  entityCui = '12345678',
  reviewedAt = '2026-04-12T15:30:00.000Z'
) =>
  createTestInteractiveRecord({
    key: `test:${entityCui}:public-debate-request-reviewed`,
    interactionId: 'funky:interaction:public_debate_request',
    lessonId: 'lesson-public-debate',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: {
          submissionPath: 'platform_send',
          subject: 'Solicitare dezbatere publica',
        },
      },
    },
    review: {
      status: 'approved',
      reviewedAt,
      feedbackText: 'Aprobat pentru trimitere.',
      reviewedByUserId: 'admin-user',
      reviewSource: 'campaign_admin_api',
    },
    updatedAt: reviewedAt,
    submittedAt: '2026-04-11T12:00:00.000Z',
  });

const encodeCursor = (cursor: CampaignNotificationAuditCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');

const parseJson = fromThrowable(JSON.parse);

const decodeCursor = (value: string): CampaignNotificationAuditCursor => {
  const parsed = parseJson(Buffer.from(value, 'base64url').toString('utf-8'));
  if (parsed.isErr()) {
    throw parsed.error;
  }

  return parsed.value as CampaignNotificationAuditCursor;
};

const makeAuditRepository = (implementation?: {
  list?: (
    input: ListCampaignNotificationAuditInput
  ) => ReturnType<CampaignNotificationAuditRepository['listCampaignNotificationAudit']>;
  meta?: () => ReturnType<CampaignNotificationAuditRepository['getCampaignNotificationMetaCounts']>;
}) => {
  const calls: ListCampaignNotificationAuditInput[] = [];
  const metaCalls: number[] = [];
  const repository: CampaignNotificationAuditRepository = {
    async listCampaignNotificationAudit(input) {
      calls.push(input);
      return implementation?.list?.(input) ?? ok({ items: [], nextCursor: null, hasMore: false });
    },
    async getCampaignNotificationMetaCounts() {
      metaCalls.push(1);
      return (
        implementation?.meta?.() ??
        ok<CampaignNotificationMetaCounts>({
          pendingDeliveryCount: 0,
          failedDeliveryCount: 0,
          replyReceivedCount: 0,
        })
      );
    },
  };

  return { repository, calls, metaCalls };
};

const makeInMemoryRunnablePlanRepository = (): CampaignNotificationRunnablePlanRepository => {
  const plans = new Map<string, CampaignNotificationStoredPlan>();

  return {
    async createPlan(input: CampaignNotificationRunnablePlanCreationInput) {
      const createdAt = new Date().toISOString();
      const plan: CampaignNotificationStoredPlan = {
        planId: randomUUID(),
        actorUserId: input.actorUserId,
        campaignKey: input.campaignKey,
        runnableId: input.runnableId,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        payloadHash: input.payloadHash,
        watermark: input.watermark,
        summary: input.summary,
        rows: input.rows,
        createdAt,
        expiresAt: input.expiresAt,
        consumedAt: null,
      };
      plans.set(plan.planId, plan);
      return ok(plan);
    },
    async findPlanById(planId: string) {
      return ok(plans.get(planId) ?? null);
    },
    async consumePlan(input) {
      const plan = plans.get(input.planId);
      if (plan?.consumedAt !== null) {
        return ok(false);
      }

      if (Date.parse(plan.expiresAt) <= Date.parse(input.now)) {
        return ok(false);
      }

      plans.set(input.planId, {
        ...plan,
        consumedAt: input.now,
      });

      return ok(true);
    },
    async releasePlan(input) {
      const plan = plans.get(input.planId);
      if (plan?.consumedAt === null || plan === undefined) {
        return ok(false);
      }

      plans.set(input.planId, {
        ...plan,
        consumedAt: null,
      });

      return ok(true);
    },
  };
};

const createAggregateExpression = () => {
  const expression = {
    filterWhere: () => expression,
    as: () => expression,
  };

  return expression;
};

interface MetaCountSelectBuilder {
  fn: {
    count: () => ReturnType<typeof createAggregateExpression>;
  };
}

const makeMetaCountDb = (counts: {
  pendingDeliveryCount: string | number | bigint;
  failedDeliveryCount: string | number | bigint;
  replyReceivedCount: string | number | bigint;
}) => {
  const query = {
    select: (selection: (builder: MetaCountSelectBuilder) => unknown) => {
      selection({
        fn: {
          count: () => createAggregateExpression(),
        },
      });
      return query;
    },
    where: () => query,
    executeTakeFirst: async () => ({
      pending_delivery_count: counts.pendingDeliveryCount,
      failed_delivery_count: counts.failedDeliveryCount,
      reply_received_count: counts.replyReceivedCount,
    }),
  };

  return {
    selectFrom: () => query,
  };
};

const createTestApp = async (options?: {
  permissionAllowed?: boolean;
  learningProgressRepo?: ReturnType<typeof makeFakeLearningProgressRepo>;
  auditRepository?: CampaignNotificationAuditRepository;
  planRepository?: CampaignNotificationRunnablePlanRepository;
  harness?: ReturnType<typeof createPublicDebateNotificationHarness>;
}) => {
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

  const harness =
    options?.harness ??
    createPublicDebateNotificationHarness({
      entityNames: {
        '12345678': 'Municipiul Exemplu',
      },
    });
  const learningProgressRepo =
    options?.learningProgressRepo ??
    makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: createAcceptedTermsRecord().key,
              record: createAcceptedTermsRecord(),
              auditEvents: [],
              updatedSeq: '1',
              createdAt: createAcceptedTermsRecord().updatedAt,
              updatedAt: createAcceptedTermsRecord().updatedAt,
            },
          ],
        ],
      ]),
    });
  const auditRepository = options?.auditRepository ?? makeAuditRepository().repository;
  const planRepository = options?.planRepository ?? makeInMemoryRunnablePlanRepository();

  await app.register(
    makeCampaignAdminNotificationRoutes({
      enabledCampaignKeys: ['funky'],
      permissionAuthorizer,
      auditRepository,
      triggerRegistry: makeCampaignNotificationTriggerRegistry({
        learningProgressRepo,
        notificationsRepo: harness.notificationsRepo,
        extendedNotificationsRepo: harness.extendedNotificationsRepo,
        deliveryRepo: harness.deliveryRepo,
        composeJobScheduler: harness.composeJobScheduler as never,
        entityRepo: harness.entityRepo,
        correspondenceRepo: harness.correspondenceRepo,
        platformBaseUrl: 'https://transparenta.eu',
      }),
      runnableTemplateRegistry: makeCampaignNotificationRunnableTemplateRegistry({
        learningProgressRepo,
        extendedNotificationsRepo: harness.extendedNotificationsRepo,
        deliveryRepo: harness.deliveryRepo,
        composeJobScheduler: harness.composeJobScheduler as never,
        entityRepo: harness.entityRepo,
        platformBaseUrl: 'https://transparenta.eu',
      }),
      planRepository,
      templatePreviewService: makeCampaignNotificationTemplatePreviewService({
        logger,
      }),
    })
  );

  await app.ready();
  return { app, testAuth, permissionAuthorizer, auditRepository, harness };
};

describe('campaign admin notifications routes', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications',
    });

    expect(response.statusCode).toBe(401);

    await setup.app.close();
  });

  it('returns 403 and does not call the audit repo when permission is denied', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      permissionAllowed: false,
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(audit.calls).toHaveLength(0);

    await setup.app.close();
  });

  it('returns 401 for notifications meta when unauthenticated', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/meta',
    });

    expect(response.statusCode).toBe(401);
    expect(audit.metaCalls).toHaveLength(0);

    await setup.app.close();
  });

  it('returns 403 for notifications meta and does not call the audit repo when permission is denied', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      permissionAllowed: false,
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(audit.metaCalls).toHaveLength(0);

    await setup.app.close();
  });

  it('returns zero-count notifications meta responses', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        pendingDeliveryCount: 0,
        failedDeliveryCount: 0,
        replyReceivedCount: 0,
      },
    });
    expect(audit.metaCalls).toHaveLength(1);

    await setup.app.close();
  });

  it('documents that Fastify currently coerces leaked string meta counts at the response boundary', async () => {
    const audit = makeAuditRepository({
      meta: async () =>
        ok({
          pendingDeliveryCount: '3' as unknown as number,
          failedDeliveryCount: '2' as unknown as number,
          replyReceivedCount: '1' as unknown as number,
        } as CampaignNotificationMetaCounts),
    });
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        pendingDeliveryCount: 3,
        failedDeliveryCount: 2,
        replyReceivedCount: 1,
      },
    });
    expect(audit.metaCalls).toHaveLength(1);

    await setup.app.close();
  });

  it('returns campaign notification meta counts for a realistic audit dataset', async () => {
    const auditRows = [
      { status: 'pending', eventType: null },
      { status: 'composing', eventType: null },
      { status: 'sending', eventType: null },
      { status: 'webhook_timeout', eventType: null },
      { status: 'failed_transient', eventType: null },
      { status: 'failed_permanent', eventType: null },
      { status: 'suppressed', eventType: null },
      { status: 'delivered', eventType: 'reply_received' },
      { status: 'sent', eventType: 'reply_received' },
      { status: 'delivered', eventType: 'thread_started' },
    ] as const;

    const audit = makeAuditRepository({
      meta: async () =>
        ok({
          pendingDeliveryCount: auditRows.filter(
            (row) =>
              row.status === 'pending' || row.status === 'composing' || row.status === 'sending'
          ).length,
          failedDeliveryCount: auditRows.filter(
            (row) =>
              row.status === 'webhook_timeout' ||
              row.status === 'failed_transient' ||
              row.status === 'failed_permanent'
          ).length,
          replyReceivedCount: auditRows.filter((row) => row.eventType === 'reply_received').length,
        }),
    });
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        pendingDeliveryCount: 3,
        failedDeliveryCount: 3,
        replyReceivedCount: 2,
      },
    });
    expect(audit.metaCalls).toHaveLength(1);

    await setup.app.close();
  });

  it('coerces Postgres string notification meta counts to numbers in the real repo', async () => {
    const auditRepository = makeCampaignNotificationOutboxAuditRepo({
      db: makeMetaCountDb({
        pendingDeliveryCount: '3',
        failedDeliveryCount: '2',
        replyReceivedCount: '1',
      }) as never,
      logger,
    });
    const setup = await createTestApp({
      auditRepository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        pendingDeliveryCount: 3,
        failedDeliveryCount: 2,
        replyReceivedCount: 1,
      },
    });

    await setup.app.close();
  });

  it('fails closed when the real repo receives malformed notification meta counts', async () => {
    const auditRepository = makeCampaignNotificationOutboxAuditRepo({
      db: makeMetaCountDb({
        pendingDeliveryCount: 'three',
        failedDeliveryCount: '2',
        replyReceivedCount: '1',
      }) as never,
      logger,
    });
    const setup = await createTestApp({
      auditRepository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'DatabaseError',
      message: 'Invalid notification meta count for pending_delivery_count.',
      retryable: false,
    });

    await setup.app.close();
  });

  it('uses createdAt desc as the default notification audit sort', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(audit.calls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      }),
    ]);

    await setup.app.close();
  });

  it('passes entityCui through to the notification audit repository', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications?entityCui=12345678',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(audit.calls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        entityCui: '12345678',
      }),
    ]);

    await setup.app.close();
  });

  it('passes userId through to the notification audit repository', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications?userId=user-1',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(audit.calls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        userId: 'user-1',
      }),
    ]);

    await setup.app.close();
  });

  it.each([
    ['createdAt', 'asc'],
    ['createdAt', 'desc'],
    ['sentAt', 'asc'],
    ['sentAt', 'desc'],
    ['status', 'asc'],
    ['status', 'desc'],
    ['attemptCount', 'asc'],
    ['attemptCount', 'desc'],
  ] as const)('passes %s %s through to the audit repository', async (sortBy, sortOrder) => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/notifications?sortBy=${sortBy}&sortOrder=${sortOrder}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(audit.calls).toEqual([
      expect.objectContaining({
        sortBy,
        sortOrder,
      }),
    ]);

    await setup.app.close();
  });

  it('returns 400 for an invalid notification cursor', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications?cursor=invalid',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign notification cursor',
      retryable: false,
    });
    expect(audit.calls).toHaveLength(0);

    await setup.app.close();
  });

  it('returns 400 for unsupported notification filters', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications?deliveryKey=secret',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(audit.calls).toHaveLength(0);

    await setup.app.close();
  });

  it('encodes nextCursor with the active sort metadata', async () => {
    const audit = makeAuditRepository({
      list: async (input) =>
        ok({
          items: [],
          hasMore: true,
          nextCursor: {
            sortBy: input.sortBy,
            sortOrder: input.sortOrder,
            id: 'outbox-2',
            value: 2,
          },
        }),
    });
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications?sortBy=attemptCount&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body: {
      data: { page: { nextCursor: string | null } };
    } = response.json();
    const nextCursor = body.data.page.nextCursor;
    expect(nextCursor).not.toBeNull();
    if (nextCursor === null) {
      return;
    }
    expect(decodeCursor(nextCursor)).toEqual({
      sortBy: 'attemptCount',
      sortOrder: 'asc',
      id: 'outbox-2',
      value: 2,
    });

    await setup.app.close();
  });

  it('rejects a cursor whose sort metadata does not match the active sort', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/notifications?sortBy=status&sortOrder=asc&cursor=${encodeCursor(
        {
          sortBy: 'createdAt',
          sortOrder: 'desc',
          id: 'outbox-1',
          value: '2026-04-10T10:00:00.000Z',
        }
      )}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(audit.calls).toHaveLength(0);

    await setup.app.close();
  });

  it('fails closed on invalid sort values through schema validation', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications?sortBy=updatedAt&sortOrder=desc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(audit.calls).toHaveLength(0);

    await setup.app.close();
  });

  it('returns 404 for unsupported campaigns', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/notifications',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);

    await setup.app.close();
  });

  it('returns 404 for unsupported campaigns on notifications meta', async () => {
    const audit = makeAuditRepository();
    const setup = await createTestApp({
      auditRepository: audit.repository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/notifications/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(audit.metaCalls).toHaveLength(0);

    await setup.app.close();
  });

  it('lists the supported trigger catalog', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({
            triggerId: 'admin_reviewed_user_interaction',
            familyId: 'admin_reviewed_interaction',
            description: expect.stringContaining('does not trigger this endpoint by default'),
          }),
          expect.objectContaining({ triggerId: 'public_debate_campaign_welcome' }),
          expect.objectContaining({ triggerId: 'public_debate_entity_subscription' }),
          expect.objectContaining({ triggerId: 'public_debate_entity_update.thread_started' }),
          expect.objectContaining({ triggerId: 'public_debate_entity_update.thread_failed' }),
          expect.objectContaining({ triggerId: 'public_debate_entity_update.reply_received' }),
          expect.objectContaining({ triggerId: 'public_debate_entity_update.reply_reviewed' }),
        ]),
      },
    });

    await setup.app.close();
  });

  it('queues an admin reviewed interaction notification for a reviewed budget document', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord();
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers/admin_reviewed_user_interaction',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        userId: 'user-1',
        recordKey: reviewedRecord.key,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        triggerId: 'admin_reviewed_user_interaction',
        templateId: 'admin_reviewed_user_interaction',
        result: expect.objectContaining({
          kind: 'family_single',
          status: 'queued',
          familyId: 'admin_reviewed_interaction',
        }),
      }),
    });

    const outbox = await setup.harness.deliveryRepo.findByDeliveryKey(
      buildAdminReviewedInteractionDeliveryKey({
        campaignKey: 'funky',
        userId: 'user-1',
        interactionId: 'funky:interaction:budget_document',
        recordKey: reviewedRecord.key,
        reviewedAt: reviewedRecord.review?.reviewedAt ?? reviewedRecord.updatedAt,
        reviewStatus: 'rejected',
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.notificationType).toBe('funky:outbox:admin_reviewed_interaction');
      expect(outbox.value?.metadata).toEqual(
        expect.objectContaining({
          familyId: 'admin_reviewed_interaction',
          interactionId: 'funky:interaction:budget_document',
          reviewStatus: 'rejected',
          entityCui: '12345678',
          nextStepLinks: [
            expect.objectContaining({
              kind: 'retry_interaction',
              url: 'https://transparenta.eu/primarie/12345678/buget/provocari/civic-campaign/civic-monitor-and-request/03-budget-status-2026',
            }),
          ],
        })
      );
    }

    await setup.app.close();
  });

  it('supports dry-run bulk execution for admin reviewed interaction notifications', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers/admin_reviewed_user_interaction/bulk',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        filters: {
          userId: 'user-1',
        },
        dryRun: true,
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        triggerId: 'admin_reviewed_user_interaction',
        result: expect.objectContaining({
          kind: 'family_bulk',
          familyId: 'admin_reviewed_interaction',
          dryRun: true,
          candidateCount: 1,
          plannedCount: 1,
          eligibleCount: 1,
          queuedCount: 1,
        }),
      }),
    });

    const outbox = await setup.harness.deliveryRepo.findByDeliveryKey(
      buildAdminReviewedInteractionDeliveryKey({
        campaignKey: 'funky',
        userId: 'user-1',
        interactionId: 'funky:interaction:budget_document',
        recordKey: reviewedRecord.key,
        reviewedAt: reviewedRecord.review?.reviewedAt ?? reviewedRecord.updatedAt,
        reviewStatus: 'rejected',
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value).toBeNull();
    }

    await setup.app.close();
  });

  it('lists runnable templates separately from preview templates', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            runnableId: 'admin_reviewed_user_interaction',
            templateId: 'admin_reviewed_user_interaction',
            dryRunRequired: true,
            selectors: expect.arrayContaining([
              expect.objectContaining({ name: 'userId' }),
              expect.objectContaining({ name: 'entityCui' }),
              expect.objectContaining({ name: 'recordKey' }),
            ]),
            filters: expect.arrayContaining([
              expect.objectContaining({ name: 'reviewStatus' }),
              expect.objectContaining({ name: 'interactionId' }),
            ]),
          }),
        ],
      },
    });

    await setup.app.close();
  });

  it('returns 401 for runnable templates when unauthenticated', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates',
    });

    expect(response.statusCode).toBe(401);

    await setup.app.close();
  });

  it('returns 403 for runnable dry-run when permission is denied', async () => {
    const setup = await createTestApp({
      permissionAllowed: false,
    });

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);

    await setup.app.close();
  });

  it('returns 404 for an unknown runnable template id', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/unknown-runnable/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      error: 'NotFoundError',
      message: 'Campaign notification runnable "unknown-runnable" was not found.',
      retryable: false,
    });

    await setup.app.close();
  });

  it('returns 500 when dry-run plan persistence fails', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({
      learningProgressRepo,
      planRepository: {
        async createPlan() {
          return err(createDatabaseError('Failed to create campaign notification run plan.'));
        },
        async findPlanById() {
          return ok(null);
        },
        async consumePlan() {
          return ok(false);
        },
        async releasePlan() {
          return ok(false);
        },
      },
    });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'DatabaseError',
      message: 'Failed to create campaign notification run plan.',
      retryable: true,
    });

    await setup.app.close();
  });

  it('creates a stored dry-run plan with safe rows and excludes delegated approved public debate requests', async () => {
    const reviewedBudgetRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const delegatedRecord = createApprovedPublicDebateRequestRecord(
      '12345678',
      '2026-04-12T16:30:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedBudgetRecord.key,
              record: reviewedBudgetRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedBudgetRecord.updatedAt,
              updatedAt: reviewedBudgetRecord.updatedAt,
            },
          ],
        ],
        [
          'user-2',
          [
            {
              userId: 'user-2',
              recordKey: delegatedRecord.key,
              record: delegatedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: delegatedRecord.updatedAt,
              updatedAt: delegatedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body: {
      data: {
        planId: string;
        summary: { totalRowCount: number; willSendCount: number };
        rows: Record<string, unknown>[];
      };
    } = response.json();
    expect(body.data.planId).toEqual(expect.any(String));
    expect(body.data.summary).toEqual(
      expect.objectContaining({
        totalRowCount: 1,
        willSendCount: 1,
      })
    );
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0]).toEqual(
      expect.objectContaining({
        interactionId: 'funky:interaction:budget_document',
        status: 'will_send',
        sendMode: 'create',
      })
    );
    expect(body.data.rows[0]).not.toHaveProperty('feedbackText');
    expect(body.data.rows[0]).not.toHaveProperty('nextStepLinks');
    expect(body.data.rows[0]).not.toHaveProperty('deliveryKey');
    expect(body.data.rows[0]).not.toHaveProperty('executionData');

    await setup.app.close();
  });

  it('rejects an invalid dry-run payload shape', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: [],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'ValidationError',
      retryable: false,
    });

    await setup.app.close();
  });

  it('pages stored dry-run plans with an opaque cursor', async () => {
    const firstRecord = createReviewedBudgetDocumentRecord('12345678', '2026-04-12T16:00:00.000Z');
    const secondRecord = createReviewedBudgetDocumentRecord('12345679', '2026-04-12T16:30:00.000Z');
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: firstRecord.key,
              record: firstRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: firstRecord.updatedAt,
              updatedAt: firstRecord.updatedAt,
            },
          ],
        ],
        [
          'user-2',
          [
            {
              userId: 'user-2',
              recordKey: secondRecord.key,
              record: secondRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: secondRecord.updatedAt,
              updatedAt: secondRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptions = await Promise.all([
      ensurePublicDebateAutoSubscriptions(
        {
          notificationsRepo: setup.harness.notificationsRepo,
          hasher: sha256Hasher,
        },
        {
          userId: 'user-1',
          entityCui: '12345678',
        }
      ),
      ensurePublicDebateAutoSubscriptions(
        {
          notificationsRepo: setup.harness.notificationsRepo,
          hasher: sha256Hasher,
        },
        {
          userId: 'user-2',
          entityCui: '12345679',
        }
      ),
    ]);
    expect(subscriptions.every((result) => result.isOk())).toBe(true);

    const dryRunResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });
    expect(dryRunResponse.statusCode).toBe(200);

    const dryRunBody: {
      data: { planId: string };
    } = dryRunResponse.json();

    const firstPageResponse = await setup.app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}?limit=1`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(firstPageResponse.statusCode).toBe(200);
    const firstPage: {
      data: {
        rows: { userId: string }[];
        page: { hasMore: boolean; nextCursor: string | null };
      };
    } = firstPageResponse.json();
    expect(firstPage.data.rows).toHaveLength(1);
    expect(firstPage.data.page.hasMore).toBe(true);
    expect(firstPage.data.page.nextCursor).toEqual(expect.any(String));

    const secondPageResponse = await setup.app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}?limit=1&cursor=${firstPage.data.page.nextCursor!}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(secondPageResponse.statusCode).toBe(200);
    const secondPage: {
      data: {
        rows: { userId: string }[];
        page: { hasMore: boolean; nextCursor: string | null };
      };
    } = secondPageResponse.json();
    expect(secondPage.data.rows).toHaveLength(1);
    expect(secondPage.data.rows[0]?.userId).not.toBe(firstPage.data.rows[0]?.userId);
    expect(secondPage.data.page.hasMore).toBe(false);
    expect(secondPage.data.page.nextCursor).toBeNull();

    await setup.app.close();
  });

  it('rejects an invalid stored-plan cursor', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const dryRunResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });
    expect(dryRunResponse.statusCode).toBe(200);

    const dryRunBody: {
      data: { planId: string };
    } = dryRunResponse.json();

    const response = await setup.app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}?cursor=invalid`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign notification plan cursor.',
      retryable: false,
    });

    await setup.app.close();
  });

  it('rejects plan reads by a different actor', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const dryRunResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });
    expect(dryRunResponse.statusCode).toBe(200);

    const dryRunBody: {
      data: { planId: string };
    } = dryRunResponse.json();

    const response = await setup.app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user2}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign notification plan.',
      retryable: false,
    });

    await setup.app.close();
  });

  it('returns 500 when loading a stored plan fails', async () => {
    const setup = await createTestApp({
      planRepository: {
        async createPlan() {
          throw new Error('not used');
        },
        async findPlanById() {
          return err(createDatabaseError('Failed to load campaign notification run plan.'));
        },
        async consumePlan() {
          return ok(false);
        },
        async releasePlan() {
          return ok(false);
        },
      },
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/plans/plan-1',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'DatabaseError',
      message: 'Failed to load campaign notification run plan.',
      retryable: true,
    });

    await setup.app.close();
  });

  it('rejects plan sends by a different actor', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const dryRunResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });
    expect(dryRunResponse.statusCode).toBe(200);

    const dryRunBody: {
      data: { planId: string };
    } = dryRunResponse.json();

    const response = await setup.app.inject({
      method: 'POST',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}/send`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user2}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign notification plan.',
      retryable: false,
    });

    await setup.app.close();
  });

  it('returns 500 when consuming a stored plan fails during send', async () => {
    const setup = await createTestApp({
      planRepository: {
        async createPlan() {
          throw new Error('not used');
        },
        async findPlanById() {
          return ok({
            planId: 'plan-1',
            actorUserId: setup.testAuth.userIds.user1,
            campaignKey: 'funky',
            runnableId: 'admin_reviewed_user_interaction',
            templateId: 'admin_reviewed_user_interaction',
            templateVersion: '1.0.0',
            payloadHash: 'hash',
            watermark: '2026-04-14T20:00:00.000Z',
            summary: {
              totalRowCount: 0,
              willSendCount: 0,
              alreadySentCount: 0,
              alreadyPendingCount: 0,
              ineligibleCount: 0,
              missingDataCount: 0,
            },
            rows: [],
            createdAt: '2026-04-14T20:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
            consumedAt: null,
          } satisfies CampaignNotificationStoredPlan);
        },
        async consumePlan() {
          return err(createDatabaseError('Failed to consume campaign notification run plan.'));
        },
        async releasePlan() {
          return ok(false);
        },
      },
    });

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/plans/plan-1/send',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'DatabaseError',
      message: 'Failed to consume campaign notification run plan.',
      retryable: true,
    });

    await setup.app.close();
  });

  it('sends a stored reviewed-interaction plan once and rejects reuse of the consumed plan', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const dryRunResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });
    expect(dryRunResponse.statusCode).toBe(200);

    const dryRunBody: {
      data: { planId: string };
    } = dryRunResponse.json();

    const sendResponse = await setup.app.inject({
      method: 'POST',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}/send`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(sendResponse.statusCode).toBe(200);
    expect(sendResponse.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        planId: dryRunBody.data.planId,
        queuedCount: 1,
        evaluatedCount: 1,
      }),
    });

    const outbox = await setup.harness.deliveryRepo.findByDeliveryKey(
      buildAdminReviewedInteractionDeliveryKey({
        campaignKey: 'funky',
        userId: 'user-1',
        interactionId: 'funky:interaction:budget_document',
        recordKey: reviewedRecord.key,
        reviewedAt: reviewedRecord.review?.reviewedAt ?? reviewedRecord.updatedAt,
        reviewStatus: 'rejected',
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.notificationType).toBe('funky:outbox:admin_reviewed_interaction');
    }

    const secondSendResponse = await setup.app.inject({
      method: 'POST',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}/send`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(secondSendResponse.statusCode).toBe(400);
    expect(secondSendResponse.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign notification plan.',
      retryable: false,
    });

    await setup.app.close();
  });

  it('sends the stored dry-run payload even if entity metadata changes before send', async () => {
    const entityNames = {
      '12345678': 'Municipiul Exemplu',
    };
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const harness = createPublicDebateNotificationHarness({ entityNames });
    const setup = await createTestApp({ learningProgressRepo, harness });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const dryRunResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });
    expect(dryRunResponse.statusCode).toBe(200);

    const dryRunBody: {
      data: { planId: string; rows: { entityName: string | null }[] };
    } = dryRunResponse.json();
    expect(dryRunBody.data.rows[0]?.entityName).toBe('Municipiul Exemplu');

    entityNames['12345678'] = 'Municipiul Schimbat';

    const sendResponse = await setup.app.inject({
      method: 'POST',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}/send`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(sendResponse.statusCode).toBe(200);
    expect(sendResponse.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        planId: dryRunBody.data.planId,
        queuedCount: 1,
      }),
    });

    const outbox = await setup.harness.deliveryRepo.findByDeliveryKey(
      buildAdminReviewedInteractionDeliveryKey({
        campaignKey: 'funky',
        userId: 'user-1',
        interactionId: 'funky:interaction:budget_document',
        recordKey: reviewedRecord.key,
        reviewedAt: reviewedRecord.review?.reviewedAt ?? reviewedRecord.updatedAt,
        reviewStatus: 'rejected',
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.metadata['entityName']).toBe('Municipiul Exemplu');
    }

    await setup.app.close();
  });

  it('revalidates the reviewed interaction before send and skips stale stored rows', async () => {
    const reviewedRecord = createReviewedBudgetDocumentRecord(
      '12345678',
      '2026-04-12T16:00:00.000Z'
    );
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [
          'user-1',
          [
            {
              userId: 'user-1',
              recordKey: reviewedRecord.key,
              record: reviewedRecord,
              auditEvents: [],
              updatedSeq: '1',
              createdAt: reviewedRecord.updatedAt,
              updatedAt: reviewedRecord.updatedAt,
            },
          ],
        ],
      ]),
    });
    const setup = await createTestApp({ learningProgressRepo });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: setup.harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const dryRunResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/runnable-templates/admin_reviewed_user_interaction/dry-run',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });
    expect(dryRunResponse.statusCode).toBe(200);

    const dryRunBody: {
      data: { planId: string };
    } = dryRunResponse.json();

    const updatedRecord = {
      ...reviewedRecord,
      phase: 'resolved' as const,
      review: {
        ...reviewedRecord.review!,
        status: 'approved' as const,
        reviewedAt: '2026-04-12T17:00:00.000Z',
      },
      updatedAt: '2026-04-12T17:00:00.000Z',
    };
    const upsertResult = await learningProgressRepo.upsertInteractiveRecord({
      userId: 'user-1',
      eventId: 'event-reviewed-update',
      clientId: 'test-client',
      occurredAt: updatedRecord.updatedAt,
      record: updatedRecord,
      auditEvents: [],
    });
    expect(upsertResult.isOk()).toBe(true);

    const sendResponse = await setup.app.inject({
      method: 'POST',
      url: `/api/v1/admin/campaigns/funky/notifications/plans/${dryRunBody.data.planId}/send`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(sendResponse.statusCode).toBe(200);
    expect(sendResponse.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        planId: dryRunBody.data.planId,
        queuedCount: 0,
        missingDataCount: 1,
        evaluatedCount: 1,
      }),
    });

    const originalOutbox = await setup.harness.deliveryRepo.findByDeliveryKey(
      buildAdminReviewedInteractionDeliveryKey({
        campaignKey: 'funky',
        userId: 'user-1',
        interactionId: 'funky:interaction:budget_document',
        recordKey: reviewedRecord.key,
        reviewedAt: reviewedRecord.review?.reviewedAt ?? reviewedRecord.updatedAt,
        reviewStatus: 'rejected',
      })
    );
    expect(originalOutbox.isOk()).toBe(true);
    if (originalOutbox.isOk()) {
      expect(originalOutbox.value).toBeNull();
    }

    await setup.app.close();
  });

  it('rejects unsupported trigger ids', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers/unknown-trigger',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);

    await setup.app.close();
  });

  it('returns previewable templates and a rendered preview', async () => {
    const setup = await createTestApp();

    const listResponse = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/templates',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({
      ok: true,
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({ templateId: 'public_debate_campaign_welcome' }),
          expect.objectContaining({ templateId: 'public_debate_entity_update' }),
        ]),
      },
    });

    const previewResponse = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications/templates/public_debate_campaign_welcome/preview',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        templateId: 'public_debate_campaign_welcome',
        html: expect.stringContaining('example.invalid'),
        exampleSubject: expect.any(String),
      }),
    });

    await setup.app.close();
  });

  it('queues a public debate campaign welcome trigger for a valid terms-accepted user', async () => {
    const setup = await createTestApp();

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers/public_debate_campaign_welcome',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        userId: 'user-1',
        entityCui: '12345678',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        triggerId: 'public_debate_campaign_welcome',
        result: expect.objectContaining({
          status: 'queued',
          createdOutboxIds: expect.any(Array),
        }),
      }),
    });

    const outbox = await setup.harness.deliveryRepo.findByDeliveryKey(
      'funky:outbox:welcome:user-1'
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.notificationType).toBe('funky:outbox:welcome');
      expect(outbox.value?.metadata['triggerSource']).toBe('campaign_admin');
      expect(outbox.value?.metadata['triggeredByUserId']).toBe(setup.testAuth.userIds.user1);
    }

    await setup.app.close();
  });

  it('skips a public debate campaign welcome trigger when the durable outbox is already terminal', async () => {
    const setup = await createTestApp();

    const firstResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers/public_debate_campaign_welcome',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        userId: 'user-1',
        entityCui: '12345678',
      },
    });
    expect(firstResponse.statusCode).toBe(200);

    const outbox = await setup.harness.deliveryRepo.findByDeliveryKey(
      'funky:outbox:welcome:user-1'
    );
    if (outbox.isOk() && outbox.value !== null) {
      await setup.harness.deliveryRepo.updateStatus(outbox.value.id, {
        status: 'delivered',
        sentAt: new Date('2026-04-12T10:00:00.000Z'),
      });
    }

    const secondResponse = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers/public_debate_campaign_welcome',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        userId: 'user-1',
        entityCui: '12345678',
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        result: expect.objectContaining({
          status: 'skipped',
          reason: 'welcome_already_processed',
        }),
      }),
    });

    await setup.app.close();
  });

  it('skips a thread trigger when the requested event does not match the current thread phase', async () => {
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-03T16:43:04.930Z'),
          record: createThreadAggregateRecord({
            campaign: 'funky',
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Oras Test',
            institutionEmail: 'contact@primarie.ro',
          }),
        }),
      ],
      entityNames: {
        '12345678': 'Municipiul Exemplu',
      },
    });
    const setup = await createTestApp({ harness });

    const response = await setup.app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/notifications/triggers/public_debate_entity_update.reply_reviewed',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
      payload: {
        threadId: 'thread-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        result: expect.objectContaining({
          status: 'skipped',
          reason: 'phase_mismatch',
        }),
      }),
    });

    await setup.app.close();
  });
});
