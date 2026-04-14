import fastifyLib from 'fastify';
import { fromThrowable, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  makeCampaignAdminNotificationRoutes,
  makeCampaignNotificationOutboxAuditRepo,
  makeCampaignNotificationTemplatePreviewService,
  makeCampaignNotificationTriggerRegistry,
  type CampaignNotificationAuditRepository,
  type CampaignNotificationAuditCursor,
  type CampaignNotificationMetaCounts,
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
