import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  makeCampaignAdminEntitiesRoutes,
  type CampaignAdminEntitiesRepository,
  type CampaignAdminEntityListCursor,
  type GetCampaignAdminEntitiesMetaCountsInput,
  type ListCampaignAdminEntitiesInput,
} from '@/modules/campaign-admin-entities/index.js';

interface CampaignAdminEntitiesResponsePage {
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly sortBy: string;
  readonly sortOrder: string;
}

interface CampaignAdminEntitiesResponseBody<TItem> {
  readonly ok: boolean;
  readonly data: {
    readonly items: TItem[];
    readonly page: CampaignAdminEntitiesResponsePage;
  };
}

interface CampaignAdminEntityResponseBody<TItem> {
  readonly ok: boolean;
  readonly data: TItem;
}

const encodeCursor = (cursor: CampaignAdminEntityListCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');

const decodeCursor = (value: string): CampaignAdminEntityListCursor =>
  parseYaml(Buffer.from(value, 'base64url').toString('utf-8')) as CampaignAdminEntityListCursor;

const makeRepository = (implementation?: {
  list?: (
    input: ListCampaignAdminEntitiesInput
  ) => ReturnType<CampaignAdminEntitiesRepository['listCampaignAdminEntities']>;
  meta?: (
    input: GetCampaignAdminEntitiesMetaCountsInput
  ) => ReturnType<CampaignAdminEntitiesRepository['getCampaignAdminEntitiesMetaCounts']>;
}) => {
  const listCalls: ListCampaignAdminEntitiesInput[] = [];
  const metaCalls: GetCampaignAdminEntitiesMetaCountsInput[] = [];
  const repository: CampaignAdminEntitiesRepository = {
    async listCampaignAdminEntities(input) {
      listCalls.push(input);
      return (
        implementation?.list?.(input) ??
        ok({
          items: [],
          totalCount: 0,
          nextCursor: null,
          hasMore: false,
        })
      );
    },
    async getCampaignAdminEntitiesMetaCounts(input) {
      metaCalls.push(input);
      return (
        implementation?.meta?.(input) ??
        ok({
          totalEntities: 0,
          entitiesWithPendingReviews: 0,
          entitiesWithSubscribers: 0,
          entitiesWithNotificationActivity: 0,
          entitiesWithFailedNotifications: 0,
        })
      );
    },
  };

  return { repository, listCalls, metaCalls };
};

async function createTestApp(options?: {
  permissionAllowed?: boolean;
  entitiesRepository?: CampaignAdminEntitiesRepository;
  platformBaseUrl?: string;
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
    makeCampaignAdminEntitiesRoutes({
      enabledCampaignKeys: ['funky'],
      permissionAuthorizer,
      entitiesRepository: options?.entitiesRepository ?? makeRepository().repository,
      platformBaseUrl: options?.platformBaseUrl ?? 'https://transparenta.test',
    })
  );

  await app.ready();
  return { app, testAuth, permissionAuthorizer };
}

describe('campaign admin entities routes', () => {
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
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities',
    });

    expect(response.statusCode).toBe(401);
    expect(repository.listCalls).toHaveLength(0);
  });

  it('returns 403 and does not call the repository when permission is denied', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      permissionAllowed: false,
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ForbiddenError',
      message: 'You do not have permission to access this campaign entity admin',
      retryable: false,
    });
    expect(setup.permissionAuthorizer.hasPermission).toHaveBeenCalledWith({
      userId: 'user_test_1',
      permissionName: 'campaign:funky_admin',
    });
    expect(repository.listCalls).toHaveLength(0);
    expect(repository.metaCalls).toHaveLength(0);
  });

  it('returns 404 for unsupported campaigns', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/entities',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(repository.listCalls).toHaveLength(0);
  });

  it('returns 401 for entity detail lookup when unauthenticated', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/12345678',
    });

    expect(response.statusCode).toBe(401);
    expect(repository.listCalls).toHaveLength(0);
  });

  it('returns 403 for entity detail lookup when permission is denied', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      permissionAllowed: false,
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/12345678',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(repository.listCalls).toHaveLength(0);
  });

  it('returns a single entity summary for direct detail-page lookup', async () => {
    const repository = makeRepository({
      list: async () =>
        ok({
          items: [
            {
              entityCui: '12345678',
              entityName: 'Municipiul Exemplu',
              userCount: 3,
              interactionCount: 4,
              pendingReviewCount: 1,
              notificationSubscriberCount: 2,
              notificationOutboxCount: 5,
              failedNotificationCount: 1,
              hasPendingReviews: true,
              hasSubscribers: true,
              hasNotificationActivity: true,
              hasFailedNotifications: true,
              latestInteractionAt: '2026-04-10T11:00:00.000Z',
              latestInteractionId: 'funky:interaction:public_debate_request',
              latestNotificationAt: '2026-04-10T12:00:00.000Z',
              latestNotificationType: 'funky:outbox:entity_update',
              latestNotificationStatus: 'failed_transient',
            },
          ],
          totalCount: 1,
          nextCursor: null,
          hasMore: false,
        }),
    });
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/12345678',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.listCalls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        entityCui: '12345678',
        sortBy: 'entityCui',
        sortOrder: 'asc',
        limit: 1,
      }),
    ]);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        userCount: 3,
        interactionCount: 4,
        pendingReviewCount: 1,
        notificationSubscriberCount: 2,
        notificationOutboxCount: 5,
        failedNotificationCount: 1,
        hasPendingReviews: true,
        hasSubscribers: true,
        hasNotificationActivity: true,
        hasFailedNotifications: true,
        latestInteractionAt: '2026-04-10T11:00:00.000Z',
        latestInteractionId: 'funky:interaction:public_debate_request',
        latestNotificationAt: '2026-04-10T12:00:00.000Z',
        latestNotificationType: 'funky:outbox:entity_update',
        latestNotificationStatus: 'failed_transient',
      },
    } satisfies CampaignAdminEntityResponseBody<Record<string, unknown>>);
  });

  it('returns 404 when the entity detail summary does not exist', async () => {
    const repository = makeRepository({
      list: async () =>
        ok({
          items: [],
          totalCount: 0,
          nextCursor: null,
          hasMore: false,
        }),
    });
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/99999999',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      error: 'NotFoundError',
      message: 'Campaign entity "99999999" not found.',
      retryable: false,
    });
  });

  it('uses latestInteractionAt desc as the default list sort', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.listCalls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        sortBy: 'latestInteractionAt',
        sortOrder: 'desc',
        limit: 50,
        interactions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
          }),
        ]),
        reviewableInteractions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          }),
        ]),
      }),
    ]);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [],
        page: {
          totalCount: 0,
          hasMore: false,
          nextCursor: null,
          sortBy: 'latestInteractionAt',
          sortOrder: 'desc',
        },
      },
    });
  });

  it('trims blank query values and defers entityName search by schema allowlist', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const blankQueryResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities?query=%20%20%20',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(blankQueryResponse.statusCode).toBe(200);
    expect(repository.listCalls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        sortBy: 'latestInteractionAt',
        sortOrder: 'desc',
        limit: 50,
        interactions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
          }),
        ]),
        reviewableInteractions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          }),
        ]),
      }),
    ]);

    const unknownFilterResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities?entityName=Primaria%20Exemplu',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(unknownFilterResponse.statusCode).toBe(400);
    expect(repository.listCalls).toHaveLength(1);
  });

  it('passes allowlisted filters through to the repository', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: [
        '/api/v1/admin/campaigns/funky/entities',
        '?query=12345678',
        '&interactionId=funky:interaction:public_debate_request',
        '&hasPendingReviews=true',
        '&hasSubscribers=false',
        '&hasNotificationActivity=true',
        '&hasFailedNotifications=false',
        '&updatedAtFrom=2026-04-01T00:00:00.000Z',
        '&updatedAtTo=2026-04-30T23:59:59.000Z',
        '&latestNotificationType=funky:outbox:entity_update',
        '&latestNotificationStatus=failed_permanent',
        '&sortBy=notificationOutboxCount',
        '&sortOrder=asc',
        '&limit=25',
      ].join(''),
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.listCalls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        interactions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
          }),
        ]),
        reviewableInteractions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          }),
        ]),
        query: '12345678',
        interactionId: 'funky:interaction:public_debate_request',
        hasPendingReviews: true,
        hasSubscribers: false,
        hasNotificationActivity: true,
        hasFailedNotifications: false,
        updatedAtFrom: '2026-04-01T00:00:00.000Z',
        updatedAtTo: '2026-04-30T23:59:59.000Z',
        latestNotificationType: 'funky:outbox:entity_update',
        latestNotificationStatus: 'failed_permanent',
        sortBy: 'notificationOutboxCount',
        sortOrder: 'asc',
        limit: 25,
      }),
    ]);
  });

  it('rejects deferred entityName sorting through schema validation', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities?sortBy=entityName&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.listCalls).toHaveLength(0);
  });

  it('returns 400 for invalid cursors', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities?cursor=invalid',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign entity cursor',
      retryable: false,
    });
    expect(repository.listCalls).toHaveLength(0);
  });

  it('returns 400 for a structured cursor with an invalid sort value payload', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const malformedCursor = encodeCursor({
      sortBy: 'latestInteractionAt',
      sortOrder: 'desc',
      entityCui: '12345678',
      value: 'not-a-date' as never,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/entities?cursor=${encodeURIComponent(malformedCursor)}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.listCalls).toHaveLength(0);
  });

  it('rejects a cursor whose sort metadata does not match the active sort', async () => {
    const repository = makeRepository();
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/campaigns/funky/entities?sortBy=entityCui&sortOrder=asc&cursor=${encodeURIComponent(
        encodeCursor({
          sortBy: 'latestNotificationAt',
          sortOrder: 'desc',
          entityCui: '12345678',
          value: '2026-04-10T10:00:00.000Z',
        })
      )}`,
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Invalid campaign entity cursor',
      retryable: false,
    });
    expect(repository.listCalls).toHaveLength(0);
  });

  it('encodes nextCursor with the active sort metadata', async () => {
    const repository = makeRepository({
      list: async (input) =>
        ok({
          items: [
            {
              entityCui: '12345678',
              entityName: 'Municipiul Exemplu',
              userCount: 3,
              interactionCount: 4,
              pendingReviewCount: 1,
              notificationSubscriberCount: 2,
              notificationOutboxCount: 5,
              failedNotificationCount: 1,
              hasPendingReviews: true,
              hasSubscribers: true,
              hasNotificationActivity: true,
              hasFailedNotifications: true,
              latestInteractionAt: '2026-04-10T11:00:00.000Z',
              latestInteractionId: 'funky:interaction:public_debate_request',
              latestNotificationAt: '2026-04-10T12:00:00.000Z',
              latestNotificationType: 'funky:outbox:entity_update',
              latestNotificationStatus: 'failed_transient',
            },
          ],
          totalCount: 2,
          hasMore: true,
          nextCursor: {
            sortBy: input.sortBy,
            sortOrder: input.sortOrder,
            entityCui: '12345678',
            value: 5,
          },
        }),
    });
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities?sortBy=notificationOutboxCount&sortOrder=desc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<CampaignAdminEntitiesResponseBody<Record<string, unknown>>>();
    expect(body.data.page.sortBy).toBe('notificationOutboxCount');
    expect(body.data.page.sortOrder).toBe('desc');
    expect(body.data.items).toEqual([
      {
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        userCount: 3,
        interactionCount: 4,
        pendingReviewCount: 1,
        notificationSubscriberCount: 2,
        notificationOutboxCount: 5,
        failedNotificationCount: 1,
        hasPendingReviews: true,
        hasSubscribers: true,
        hasNotificationActivity: true,
        hasFailedNotifications: true,
        latestInteractionAt: '2026-04-10T11:00:00.000Z',
        latestInteractionId: 'funky:interaction:public_debate_request',
        latestNotificationAt: '2026-04-10T12:00:00.000Z',
        latestNotificationType: 'funky:outbox:entity_update',
        latestNotificationStatus: 'failed_transient',
      },
    ]);
    expect(body.data.page.hasMore).toBe(true);
    expect(body.data.page.nextCursor).not.toBeNull();
    if (body.data.page.nextCursor !== null) {
      expect(decodeCursor(body.data.page.nextCursor)).toEqual({
        sortBy: 'notificationOutboxCount',
        sortOrder: 'desc',
        entityCui: '12345678',
        value: 5,
      });
    }
  });

  it('returns repository validation errors with mapped HTTP status', async () => {
    const repository = makeRepository({
      list: async () =>
        err({
          type: 'ValidationError',
          message: 'Entity filter combination is invalid',
        }),
    });
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities?hasSubscribers=true',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ValidationError',
      message: 'Entity filter combination is invalid',
      retryable: false,
    });
  });

  it('serves the entities meta endpoint through the same auth boundary', async () => {
    const repository = makeRepository({
      meta: async () =>
        ok({
          totalEntities: 12,
          entitiesWithPendingReviews: 4,
          entitiesWithSubscribers: 7,
          entitiesWithNotificationActivity: 8,
          entitiesWithFailedNotifications: 2,
        }),
    });
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/meta',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.metaCalls).toEqual([
      expect.objectContaining({
        campaignKey: 'funky',
        interactions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
          }),
        ]),
        reviewableInteractions: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
            submissionPath: 'request_platform',
          }),
        ]),
      }),
    ]);
    expect(response.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        totalEntities: 12,
        entitiesWithPendingReviews: 4,
        entitiesWithSubscribers: 7,
        entitiesWithNotificationActivity: 8,
        entitiesWithFailedNotifications: 2,
        availableInteractionTypes: expect.arrayContaining([
          expect.objectContaining({
            interactionId: 'funky:interaction:public_debate_request',
            label: 'Public debate request',
            reviewable: true,
          }),
        ]),
      }),
    });
  });

  it('exports entities csv with paging, labels, and spreadsheet-safe cells', async () => {
    const firstCursor = {
      sortBy: 'userCount' as const,
      sortOrder: 'asc' as const,
      entityCui: '12345678',
      value: 4,
    };
    const repository = makeRepository({
      list: async (input) => {
        if (input.cursor === undefined) {
          return ok({
            items: [
              {
                entityCui: '12345678',
                entityName: '+Oras Test',
                userCount: 4,
                interactionCount: 5,
                pendingReviewCount: 1,
                notificationSubscriberCount: 2,
                notificationOutboxCount: 3,
                failedNotificationCount: 1,
                hasPendingReviews: true,
                hasSubscribers: true,
                hasNotificationActivity: true,
                hasFailedNotifications: true,
                latestInteractionAt: '2026-04-10T10:00:00.000Z',
                latestInteractionId: 'funky:interaction:public_debate_request',
                latestNotificationAt: '2026-04-10T11:00:00.000Z',
                latestNotificationType: 'funky:outbox:entity_update',
                latestNotificationStatus: 'failed_permanent',
              },
            ],
            totalCount: 2,
            hasMore: true,
            nextCursor: firstCursor,
          });
        }

        return ok({
          items: [
            {
              entityCui: '87654321',
              entityName: null,
              userCount: 7,
              interactionCount: 0,
              pendingReviewCount: 0,
              notificationSubscriberCount: 0,
              notificationOutboxCount: 0,
              failedNotificationCount: 0,
              hasPendingReviews: false,
              hasSubscribers: false,
              hasNotificationActivity: false,
              hasFailedNotifications: false,
              latestInteractionAt: null,
              latestInteractionId: null,
              latestNotificationAt: null,
              latestNotificationType: null,
              latestNotificationStatus: null,
            },
          ],
          totalCount: 2,
          hasMore: false,
          nextCursor: null,
        });
      },
    });
    const setup = await createTestApp({
      entitiesRepository: repository.repository,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/entities/export?sortBy=userCount&sortOrder=asc',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'accept-language': 'en-US,en;q=0.9',
        origin: 'http://localhost:3001',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain(
      'funky-campaign-admin-entities-export-'
    );
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['surrogate-control']).toBe('no-store');
    expect(response.headers['cdn-cache-control']).toContain('no-store');
    expect(response.headers.vary).toContain('Origin');
    expect(response.headers.vary).toContain('Authorization');
    expect(response.headers.vary).toContain('Accept-Language');
    expect(repository.listCalls).toHaveLength(2);
    expect(repository.listCalls[0]).toMatchObject({
      sortBy: 'userCount',
      sortOrder: 'asc',
      limit: 250,
    });
    expect(repository.listCalls[1]?.cursor).toEqual(firstCursor);

    const csvBody = response.body.startsWith('\uFEFF') ? response.body.slice(1) : response.body;
    const csvLines = csvBody.trimEnd().split('\n');

    expect(csvLines).toHaveLength(3);
    expect(csvLines[0]).toContain('Entity Name,Entity CUI,Users');
    expect(csvBody).toContain("'+Oras Test");
    expect(csvBody).toContain('Entity update');
    expect(csvBody).toContain('Permanent failure');
    expect(csvBody).toContain('https://transparenta.test/primarie/12345678');
    expect(csvBody).toContain('87654321,87654321');
    expect(csvBody).toContain('Unavailable');
  });
});
