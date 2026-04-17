import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import { type CampaignAdminPermissionAuthorizer } from '@/modules/campaign-admin/index.js';
import {
  createDatabaseError as createEntityDatabaseError,
  type EntityRepository,
} from '@/modules/entity/index.js';
import {
  makeCampaignAdminInstitutionThreadRoutes,
  type CampaignAdminThreadNotificationService,
} from '@/modules/institution-correspondence/index.js';

import {
  createAdminResponseEvent,
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../unit/institution-correspondence/fake-repo.js';

function makeEntityRepoStub(options?: {
  names?: Record<string, string>;
  failLookup?: boolean;
}): EntityRepository {
  return {
    async getById(cui) {
      if (options?.failLookup === true) {
        return err(createEntityDatabaseError('entity lookup failed'));
      }

      const name = options?.names?.[cui];
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
      if (options?.failLookup === true) {
        return err(createEntityDatabaseError('entity lookup failed'));
      }

      return ok(
        new Map(
          cuis.flatMap((cui) => {
            const name = options?.names?.[cui];
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
  } satisfies EntityRepository;
}

function makeNotificationServiceStub(
  overrides: Partial<CampaignAdminThreadNotificationService> = {}
): CampaignAdminThreadNotificationService {
  return {
    summarizeAudiences: vi.fn(async (threads: readonly { id: string }[]) =>
      ok(
        new Map<
          string,
          {
            requesterCount: number;
            subscriberCount: number;
            eligibleRequesterCount: number;
            eligibleSubscriberCount: number;
          }
        >(
          threads.map((thread) => [
            thread.id,
            thread.id === '11111111-1111-1111-1111-111111111111'
              ? {
                  requesterCount: 1,
                  subscriberCount: 2,
                  eligibleRequesterCount: 1,
                  eligibleSubscriberCount: 1,
                }
              : thread.id === '22222222-2222-2222-2222-222222222222'
                ? {
                    requesterCount: 0,
                    subscriberCount: 3,
                    eligibleRequesterCount: 0,
                    eligibleSubscriberCount: 2,
                  }
                : {
                    requesterCount: 0,
                    subscriberCount: 0,
                    eligibleRequesterCount: 0,
                    eligibleSubscriberCount: 0,
                  },
          ])
        )
      )
    ),
    notifyResponseById: vi.fn(async () => ({
      requested: true as const,
      status: 'queued' as const,
      requesterCount: 1,
      subscriberCount: 2,
      eligibleRequesterCount: 1,
      eligibleSubscriberCount: 1,
      createdOutboxIds: ['outbox-admin-response-1'],
      reusedOutboxIds: [],
      queuedOutboxIds: ['outbox-admin-response-1'],
      enqueueFailedOutboxIds: [],
    })),
    notifyLatestResponse: vi.fn(async () => ({
      requested: true as const,
      status: 'queued' as const,
      requesterCount: 1,
      subscriberCount: 2,
      eligibleRequesterCount: 1,
      eligibleSubscriberCount: 1,
      createdOutboxIds: ['outbox-admin-response-latest'],
      reusedOutboxIds: [],
      queuedOutboxIds: ['outbox-admin-response-latest'],
      enqueueFailedOutboxIds: [],
    })),
    ...overrides,
  };
}

async function createTestApp(options?: {
  permissionAllowed?: boolean;
  entityRepo?: EntityRepository;
  notificationService?: CampaignAdminThreadNotificationService;
}) {
  const testAuth = createTestAuthProvider();
  const app = fastifyLib({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const typedError = error as {
      statusCode?: number;
      code?: string;
      name?: string;
      message?: string;
    };

    void reply.status(typedError.statusCode ?? 500).send({
      ok: false,
      error: typedError.code ?? typedError.name ?? 'Error',
      message: typedError.message ?? 'An error occurred',
      retryable: false,
    });
  });

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

  const permissionAuthorizer: CampaignAdminPermissionAuthorizer = {
    hasPermission: vi.fn(async () => options?.permissionAllowed ?? true),
  };

  const repo = makeInMemoryCorrespondenceRepo({
    threads: [
      createThreadRecord({
        id: '11111111-1111-1111-1111-111111111111',
        entityCui: '12345678',
        campaignKey: 'funky',
        phase: 'awaiting_reply',
        updatedAt: new Date('2026-03-24T12:00:00.000Z'),
        record: createThreadAggregateRecord({
          campaignKey: 'funky',
          submissionPath: 'platform_send',
          institutionEmail: 'contact@alpha.ro',
          correspondence: [
            createCorrespondenceEntry({
              id: 'outbound-1',
              direction: 'outbound',
              source: 'platform_send',
              textBody: 'Outbound body',
              htmlBody: '<p>Outbound body</p>',
              toAddresses: ['capture@transparenta.test'],
              ccAddresses: ['audit@transparenta.test'],
              bccAddresses: ['bcc@transparenta.test'],
            }),
          ],
        }),
      }),
      createThreadRecord({
        id: '22222222-2222-2222-2222-222222222222',
        entityCui: '87654321',
        campaignKey: 'funky',
        phase: 'reply_received_unreviewed',
        updatedAt: new Date('2026-03-24T13:00:00.000Z'),
        record: createThreadAggregateRecord({
          campaignKey: 'funky',
          submissionPath: 'platform_send',
          institutionEmail: 'office@beta.ro',
          correspondence: [
            createCorrespondenceEntry({
              id: 'reply-1',
              direction: 'inbound',
              source: 'institution_reply',
              textBody: 'Inbound body',
              htmlBody: '<p>Inbound body</p>',
              occurredAt: '2026-03-24T12:45:00.000Z',
            }),
          ],
        }),
      }),
      createThreadRecord({
        id: '33333333-3333-3333-3333-333333333333',
        entityCui: '55555555',
        campaignKey: 'funky',
        phase: 'awaiting_reply',
        updatedAt: new Date('2026-03-24T14:00:00.000Z'),
        record: createThreadAggregateRecord({
          campaignKey: 'funky',
          submissionPath: 'platform_send',
          institutionEmail: 'resolved@gamma.ro',
          adminWorkflow: {
            currentResponseStatus: 'request_denied',
            responseEvents: [
              createAdminResponseEvent({
                id: 'response-denied-1',
                responseDate: '2026-03-24T13:30:00.000Z',
                responseStatus: 'request_denied',
                messageContent: 'Request denied.',
              }),
            ],
          },
        }),
      }),
      createThreadRecord({
        id: '44444444-4444-4444-4444-444444444444',
        entityCui: '99999999',
        campaignKey: 'funky',
        phase: 'failed',
        record: createThreadAggregateRecord({
          campaignKey: 'funky',
          submissionPath: 'platform_send',
        }),
      }),
      createThreadRecord({
        id: '55555555-5555-5555-5555-555555555555',
        entityCui: '66666666',
        campaignKey: 'funky',
        phase: 'awaiting_reply',
        record: createThreadAggregateRecord({
          campaignKey: 'funky',
          submissionPath: 'self_send_cc',
        }),
      }),
      createThreadRecord({
        id: '66666666-6666-6666-6666-666666666666',
        entityCui: '77777777',
        campaignKey: 'other',
        phase: 'awaiting_reply',
        record: createThreadAggregateRecord({
          campaignKey: 'other',
          submissionPath: 'platform_send',
        }),
      }),
      createThreadRecord({
        id: '77777777-7777-7777-7777-777777777777',
        entityCui: '88888888',
        campaignKey: 'funky',
        phase: 'sending',
        record: createThreadAggregateRecord({
          campaignKey: 'funky',
          submissionPath: 'platform_send',
        }),
      }),
    ],
  });

  await app.register(
    makeCampaignAdminInstitutionThreadRoutes({
      repo,
      entityRepo:
        options?.entityRepo ??
        makeEntityRepoStub({
          names: {
            '12345678': 'Municipiul Alpha',
            '87654321': 'Comuna Beta',
            '55555555': 'Comuna Gamma',
          },
        }),
      notificationService: options?.notificationService ?? makeNotificationServiceStub(),
      permissionAuthorizer,
      enabledCampaignKeys: ['funky'],
    })
  );

  await app.ready();
  return { app, repo, testAuth, permissionAuthorizer };
}

describe('campaign admin institution threads routes', () => {
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
      url: '/api/v1/admin/campaigns/funky/institution-threads',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 403 when permission is denied', async () => {
    const setup = await createTestApp({ permissionAllowed: false });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(setup.permissionAuthorizer.hasPermission).toHaveBeenCalledWith({
      userId: 'user_test_1',
      permissionName: 'campaign:funky_admin',
    });
  });

  it('returns 404 for unsupported campaigns', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/institution-threads',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('lists scoped threads, supports filters, and rejects contradictory or unknown filters', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const invalidResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads?invalid=true',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(invalidResponse.statusCode).toBe(400);

    const contradictoryResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads?stateGroup=closed&threadState=pending',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(contradictoryResponse.statusCode).toBe(400);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads?stateGroup=open&threadState=pending&query=beta',
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
            id: '22222222-2222-2222-2222-222222222222',
            entityName: 'Comuna Beta',
            submissionPath: 'platform_send',
            threadState: 'pending',
            currentResponseStatus: null,
            responseEventCount: 0,
            notificationAudience: {
              requesterCount: 0,
              subscriberCount: 3,
              eligibleRequesterCount: 0,
              eligibleSubscriberCount: 2,
            },
          }),
        ],
        page: expect.objectContaining({
          limit: 50,
          totalCount: 1,
          sortBy: 'updatedAt',
          sortOrder: 'desc',
        }),
      },
    });

    const responseStatusFilter = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads?responseStatus=request_denied',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(responseStatusFilter.statusCode).toBe(200);
    expect(responseStatusFilter.json().data.items).toEqual([
      expect.objectContaining({
        id: '33333333-3333-3333-3333-333333333333',
        threadState: 'resolved',
        currentResponseStatus: 'request_denied',
      }),
    ]);
  });

  it('returns redacted detail data and falls back to null entityName on lookup failure', async () => {
    const setup = await createTestApp({
      entityRepo: makeEntityRepoStub({ failLookup: true }),
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads/22222222-2222-2222-2222-222222222222',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        id: '22222222-2222-2222-2222-222222222222',
        entityName: null,
        threadState: 'pending',
        notificationAudience: {
          requesterCount: 0,
          subscriberCount: 3,
          eligibleRequesterCount: 0,
          eligibleSubscriberCount: 2,
        },
        responseEvents: [],
        correspondence: [
          expect.not.objectContaining({
            htmlBody: expect.anything(),
            toAddresses: expect.anything(),
            ccAddresses: expect.anything(),
            bccAddresses: expect.anything(),
          }),
        ],
      }),
    });
  });

  it('hides out-of-scope and failed thread ids, and removes the old standalone route', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const selfSendResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads/55555555-5555-5555-5555-555555555555',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(selfSendResponse.statusCode).toBe(404);

    const failedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads/44444444-4444-4444-4444-444444444444',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(failedResponse.statusCode).toBe(404);

    const sendingResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/institution-threads/77777777-7777-7777-7777-777777777777',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(sendingResponse.statusCode).toBe(404);

    const sendingAppendResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/77777777-7777-7777-7777-777777777777/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T12:00:00.000Z',
        responseDate: '2026-03-24T12:30:00.000Z',
        messageContent: 'Should stay out of scope.',
        responseStatus: 'registration_number_received',
      },
    });

    expect(sendingAppendResponse.statusCode).toBe(404);

    const oldRouteResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/institution-correspondence/threads/11111111-1111-1111-1111-111111111111',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(oldRouteResponse.statusCode).toBe(404);
  });

  it('appends response events and enforces forward-only resolved transitions', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const appendResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/11111111-1111-1111-1111-111111111111/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T12:00:00.000Z',
        responseDate: '2026-03-24T12:30:00.000Z',
        messageContent: '  Registration number received from the institution.  ',
        responseStatus: 'registration_number_received',
      },
    });

    expect(appendResponse.statusCode).toBe(200);
    const appendData = appendResponse.json().data as {
      updatedAt: string;
      threadState: string;
      currentResponseStatus: string | null;
      notificationAudience: {
        requesterCount: number;
        subscriberCount: number;
        eligibleRequesterCount: number;
        eligibleSubscriberCount: number;
      };
      createdResponseEventId: string;
      responseEvents: { id: string; messageContent: string }[];
    };
    expect(appendData.threadState).toBe('pending');
    expect(appendData.currentResponseStatus).toBe('registration_number_received');
    expect(appendData.notificationAudience).toEqual({
      requesterCount: 1,
      subscriberCount: 2,
      eligibleRequesterCount: 1,
      eligibleSubscriberCount: 1,
    });
    expect(appendData.createdResponseEventId).toBeTruthy();
    expect(appendData.responseEvents).toEqual([
      expect.objectContaining({
        id: appendData.createdResponseEventId,
        messageContent: 'Registration number received from the institution.',
      }),
    ]);

    const staleRetry = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/11111111-1111-1111-1111-111111111111/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T12:00:00.000Z',
        responseDate: '2026-03-24T12:35:00.000Z',
        messageContent: 'Stale update',
        responseStatus: 'registration_number_received',
      },
    });

    expect(staleRetry.statusCode).toBe(409);

    const resolvedWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/33333333-3333-3333-3333-333333333333/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T14:00:00.000Z',
        responseDate: '2026-03-24T14:05:00.000Z',
        messageContent: 'Should not be accepted.',
        responseStatus: 'registration_number_received',
      },
    });

    expect(resolvedWrite.statusCode).toBe(409);
  });

  it('does not enqueue admin-response notifications when sendNotification is omitted or false', async () => {
    const notificationService = makeNotificationServiceStub();
    const setup = await createTestApp({ notificationService });
    app = setup.app;

    const omittedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/11111111-1111-1111-1111-111111111111/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T12:00:00.000Z',
        responseDate: '2026-03-24T12:30:00.000Z',
        messageContent: 'Saved only.',
        responseStatus: 'registration_number_received',
      },
    });

    expect(omittedResponse.statusCode).toBe(200);
    expect(omittedResponse.json().data.notificationExecution).toBeUndefined();
    expect(notificationService.notifyResponseById).not.toHaveBeenCalled();

    const falseResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/22222222-2222-2222-2222-222222222222/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T13:00:00.000Z',
        responseDate: '2026-03-24T13:30:00.000Z',
        messageContent: 'Still save only.',
        responseStatus: 'request_confirmed',
        sendNotification: false,
      },
    });

    expect(falseResponse.statusCode).toBe(200);
    expect(falseResponse.json().data.notificationExecution).toBeUndefined();
    expect(notificationService.notifyResponseById).not.toHaveBeenCalled();
  });

  it('returns notificationExecution when sendNotification is true', async () => {
    const notificationService = makeNotificationServiceStub({
      notifyResponseById: vi.fn(async () => ({
        requested: true as const,
        status: 'queued' as const,
        requesterCount: 1,
        subscriberCount: 4,
        eligibleRequesterCount: 1,
        eligibleSubscriberCount: 3,
        createdOutboxIds: ['outbox-queued-1'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['outbox-queued-1'],
        enqueueFailedOutboxIds: [],
      })),
    });
    const setup = await createTestApp({ notificationService });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/11111111-1111-1111-1111-111111111111/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T12:00:00.000Z',
        responseDate: '2026-03-24T12:30:00.000Z',
        messageContent: 'Send this update.',
        responseStatus: 'registration_number_received',
        sendNotification: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.notificationExecution).toEqual({
      requested: true,
      status: 'queued',
      requesterCount: 1,
      subscriberCount: 4,
      eligibleRequesterCount: 1,
      eligibleSubscriberCount: 3,
      createdOutboxIds: ['outbox-queued-1'],
      reusedOutboxIds: [],
      queuedOutboxIds: ['outbox-queued-1'],
      enqueueFailedOutboxIds: [],
    });
    expect(notificationService.notifyResponseById).toHaveBeenCalledTimes(1);
  });

  it('returns skipped notificationExecution when no recipients are eligible', async () => {
    const notificationService = makeNotificationServiceStub({
      notifyResponseById: vi.fn(async () => ({
        requested: true as const,
        status: 'skipped' as const,
        reason: 'no_eligible_recipients' as const,
        requesterCount: 1,
        subscriberCount: 2,
        eligibleRequesterCount: 0,
        eligibleSubscriberCount: 0,
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      })),
    });
    const setup = await createTestApp({ notificationService });
    app = setup.app;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns/funky/institution-threads/11111111-1111-1111-1111-111111111111/responses',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        expectedUpdatedAt: '2026-03-24T12:00:00.000Z',
        responseDate: '2026-03-24T12:30:00.000Z',
        messageContent: 'No recipients left.',
        responseStatus: 'registration_number_received',
        sendNotification: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.notificationExecution).toEqual({
      requested: true,
      status: 'skipped',
      reason: 'no_eligible_recipients',
      requesterCount: 1,
      subscriberCount: 2,
      eligibleRequesterCount: 0,
      eligibleSubscriberCount: 0,
      createdOutboxIds: [],
      reusedOutboxIds: [],
      queuedOutboxIds: [],
      enqueueFailedOutboxIds: [],
    });
  });
});
