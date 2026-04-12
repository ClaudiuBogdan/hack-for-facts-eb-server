import fastifyLib from 'fastify';
import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  makeCampaignAdminNotificationRoutes,
  makeCampaignNotificationTemplatePreviewService,
  makeCampaignNotificationTriggerRegistry,
} from '@/modules/campaign-admin-notifications/index.js';

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

const createTestApp = async (options?: {
  permissionAllowed?: boolean;
  learningProgressRepo?: ReturnType<typeof makeFakeLearningProgressRepo>;
  auditRepository?: {
    listCampaignNotificationAudit: ReturnType<typeof vi.fn>;
  };
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
  const auditRepository = options?.auditRepository ?? {
    listCampaignNotificationAudit: vi.fn(async () =>
      ok({
        items: [],
        nextCursor: null,
        hasMore: false,
      })
    ),
  };

  await app.register(
    makeCampaignAdminNotificationRoutes({
      enabledCampaignKeys: ['funky'],
      permissionAuthorizer,
      auditRepository: auditRepository as never,
      triggerRegistry: makeCampaignNotificationTriggerRegistry({
        learningProgressRepo,
        notificationsRepo: harness.notificationsRepo,
        extendedNotificationsRepo: harness.extendedNotificationsRepo,
        deliveryRepo: harness.deliveryRepo,
        composeJobScheduler: harness.composeJobScheduler as never,
        entityRepo: harness.entityRepo,
        correspondenceRepo: harness.correspondenceRepo,
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
    const auditRepository = {
      listCampaignNotificationAudit: vi.fn(),
    };
    const setup = await createTestApp({
      permissionAllowed: false,
      auditRepository,
    });

    const response = await setup.app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/notifications',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(auditRepository.listCampaignNotificationAudit).not.toHaveBeenCalled();

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
