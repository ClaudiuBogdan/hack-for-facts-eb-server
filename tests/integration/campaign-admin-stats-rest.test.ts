import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  makeCampaignAdminStatsRoutes,
  type CampaignAdminStatsInteractionsByType,
  type CampaignAdminStatsOverview,
  type CampaignAdminStatsReader,
  type CampaignAdminStatsTopEntities,
} from '@/modules/campaign-admin-stats/index.js';

const baseOverview: CampaignAdminStatsOverview = {
  coverage: {
    hasClientTelemetry: false,
    hasNotificationAttribution: true,
  },
  users: {
    totalUsers: 12,
    usersWithPendingReviews: 3,
  },
  interactions: {
    totalInteractions: 18,
    interactionsWithInstitutionThread: 4,
    reviewStatusCounts: {
      pending: 5,
      approved: 7,
      rejected: 2,
      notReviewed: 4,
    },
    phaseCounts: {
      idle: 0,
      draft: 2,
      pending: 5,
      resolved: 8,
      failed: 3,
    },
    threadPhaseCounts: {
      sending: 1,
      awaitingReply: 1,
      replyReceivedUnreviewed: 1,
      manualFollowUpNeeded: 0,
      resolvedPositive: 0,
      resolvedNegative: 0,
      closedNoResponse: 0,
      failed: 1,
      none: 14,
    },
  },
  entities: {
    totalEntities: 6,
    entitiesWithPendingReviews: 2,
    entitiesWithSubscribers: 4,
    entitiesWithNotificationActivity: 3,
    entitiesWithFailedNotifications: 1,
  },
  notifications: {
    pendingDeliveryCount: 2,
    failedDeliveryCount: 1,
    deliveredCount: 8,
    openedCount: 5,
    clickedCount: 2,
    suppressedCount: 1,
  },
};

const baseInteractionsByType: CampaignAdminStatsInteractionsByType = {
  items: [
    {
      interactionId: 'funky:interaction:city_hall_website',
      label: 'City hall website',
      total: 9,
      pending: 2,
      approved: 4,
      rejected: 1,
      notReviewed: 2,
    },
    {
      interactionId: 'funky:interaction:public_debate_request',
      label: 'Public debate request',
      total: 6,
      pending: 1,
      approved: 3,
      rejected: 1,
      notReviewed: 1,
    },
  ],
};

const baseTopEntities: CampaignAdminStatsTopEntities = {
  sortBy: 'interactionCount',
  limit: 10,
  items: [
    {
      entityCui: '11111111',
      entityName: 'Entity One',
      interactionCount: 9,
      userCount: 4,
      pendingReviewCount: 2,
    },
    {
      entityCui: '22222222',
      entityName: 'Entity Two',
      interactionCount: 6,
      userCount: 5,
      pendingReviewCount: 1,
    },
  ],
};

function makeReader(options?: {
  readonly getOverview?: (
    campaignKey: string
  ) => ReturnType<CampaignAdminStatsReader['getOverview']>;
  readonly getInteractionsByType?: (
    campaignKey: string
  ) => ReturnType<CampaignAdminStatsReader['getInteractionsByType']>;
  readonly getTopEntities?: (
    input: Parameters<CampaignAdminStatsReader['getTopEntities']>[0]
  ) => ReturnType<CampaignAdminStatsReader['getTopEntities']>;
}): CampaignAdminStatsReader & {
  getOverview: ReturnType<typeof vi.fn>;
  getInteractionsByType: ReturnType<typeof vi.fn>;
  getTopEntities: ReturnType<typeof vi.fn>;
} {
  return {
    getOverview: vi.fn(async (input) => {
      return options?.getOverview?.(input.campaignKey) ?? ok(baseOverview);
    }),
    getInteractionsByType: vi.fn(async (input) => {
      return options?.getInteractionsByType?.(input.campaignKey) ?? ok(baseInteractionsByType);
    }),
    getTopEntities: vi.fn(async (input) => {
      return (
        options?.getTopEntities?.(input) ??
        ok({
          ...baseTopEntities,
          sortBy: input.sortBy,
          limit: input.limit,
        })
      );
    }),
  };
}

async function createTestApp(options?: {
  readonly reader?: CampaignAdminStatsReader;
  readonly permissionAllowed?: boolean;
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

  const reader = options?.reader ?? makeReader();

  await app.register(
    makeCampaignAdminStatsRoutes({
      enabledCampaignKeys: ['funky'],
      permissionAuthorizer,
      reader,
    })
  );

  await app.ready();
  return { app, testAuth, permissionAuthorizer, reader };
}

describe('Campaign Admin Stats REST API', () => {
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

  it('returns 401 for interactions-by-type when authentication is missing', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/interactions/by-type',
    });

    expect(response.statusCode).toBe(401);
    expect(setup.reader.getInteractionsByType).not.toHaveBeenCalled();
  });

  it('fails fast when the permission authorizer is misconfigured', () => {
    expect(() =>
      makeCampaignAdminStatsRoutes({
        enabledCampaignKeys: ['funky'],
        permissionAuthorizer: {} as unknown as Parameters<
          typeof makeCampaignAdminStatsRoutes
        >[0]['permissionAuthorizer'],
        reader: makeReader(),
      })
    ).toThrow('Campaign admin stats routes require a permission authorizer');
  });

  it('returns 403 for top-entities when the authenticated user lacks permission', async () => {
    const setup = await createTestApp({
      permissionAllowed: false,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=interactionCount',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ForbiddenError',
      message: 'You do not have permission to access this campaign stats overview',
      retryable: false,
    });
    expect(setup.reader.getTopEntities).not.toHaveBeenCalled();
  });

  it('returns 404 for unsupported campaigns on top-entities', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/stats/entities/top?sortBy=interactionCount',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(setup.reader.getTopEntities).not.toHaveBeenCalled();
  });

  it('returns a sanitized overview response for authorized users', async () => {
    const reader = makeReader({
      getOverview: async () =>
        ok({
          ...baseOverview,
          users: {
            ...baseOverview.users,
            institutionEmail: 'hidden@example.com',
          },
          notifications: {
            ...baseOverview.notifications,
            clickLink: 'https://example.invalid/private-token',
            renderedText: 'Sensitive email content',
            toEmail: 'user@example.com',
          },
          renderedHtml: '<p>hidden</p>',
        } as unknown as CampaignAdminStatsOverview),
    });
    const setup = await createTestApp({ reader });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/overview',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: baseOverview,
    });
    expect(reader.getOverview).toHaveBeenCalledWith({
      campaignKey: 'funky',
    });

    const body = response.body;
    expect(body).not.toContain('institutionEmail');
    expect(body).not.toContain('hidden@example.com');
    expect(body).not.toContain('clickLink');
    expect(body).not.toContain('private-token');
    expect(body).not.toContain('renderedHtml');
    expect(body).not.toContain('renderedText');
    expect(body).not.toContain('toEmail');
  });

  it('returns a sanitized ranked interactions-by-type response', async () => {
    const reader = makeReader({
      getInteractionsByType: async () =>
        ok({
          items: [
            {
              ...baseInteractionsByType.items[0],
              contactEmail: 'hidden@example.com',
              rawPayload: { secret: true },
            },
          ],
        } as unknown as CampaignAdminStatsInteractionsByType),
    });
    const setup = await createTestApp({ reader });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/interactions/by-type',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [baseInteractionsByType.items[0]],
      },
    });

    const body = response.body;
    expect(body).not.toContain('contactEmail');
    expect(body).not.toContain('hidden@example.com');
    expect(body).not.toContain('rawPayload');
  });

  it('returns a sanitized top-entities response ordered by the requested metric', async () => {
    const reader = makeReader({
      getTopEntities: async (input) =>
        ok({
          sortBy: input.sortBy,
          limit: input.limit,
          items: [
            {
              ...baseTopEntities.items[0],
              institutionEmail: 'hidden@example.com',
              rawClickUrl: 'https://example.invalid/private-token',
            },
          ],
        } as unknown as CampaignAdminStatsTopEntities),
    });
    const setup = await createTestApp({ reader });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=userCount&limit=2',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        sortBy: 'userCount',
        limit: 2,
        items: [baseTopEntities.items[0]],
      },
    });
    expect(reader.getTopEntities).toHaveBeenCalledWith({
      campaignKey: 'funky',
      sortBy: 'userCount',
      limit: 2,
    });

    const body = response.body;
    expect(body).not.toContain('institutionEmail');
    expect(body).not.toContain('hidden@example.com');
    expect(body).not.toContain('rawClickUrl');
    expect(body).not.toContain('private-token');
  });

  it('applies the default top-entities limit', async () => {
    const reader = makeReader();
    const setup = await createTestApp({ reader });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=interactionCount',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(reader.getTopEntities).toHaveBeenCalledWith({
      campaignKey: 'funky',
      sortBy: 'interactionCount',
      limit: 10,
    });
  });

  it('rejects invalid top-entities sortBy values', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=invalid',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(setup.reader.getTopEntities).not.toHaveBeenCalled();
  });

  it('rejects top-entities limits below the minimum', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=interactionCount&limit=0',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(setup.reader.getTopEntities).not.toHaveBeenCalled();
  });

  it('rejects top-entities limits above the maximum', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=interactionCount&limit=26',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(setup.reader.getTopEntities).not.toHaveBeenCalled();
  });

  it('returns 500 when interactions-by-type violates the integer response contract', async () => {
    const reader = makeReader({
      getInteractionsByType: async () =>
        ok({
          items: [
            {
              ...baseInteractionsByType.items[0],
              total: 9.5,
            },
          ],
        } as unknown as CampaignAdminStatsInteractionsByType),
    });
    const setup = await createTestApp({ reader });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/interactions/by-type',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'Error',
      message: 'Campaign admin stats interactions-by-type response violates schema',
      retryable: false,
    });
  });

  it('returns 500 when top-entities violates the integer response contract', async () => {
    const reader = makeReader({
      getTopEntities: async (input) =>
        ok({
          sortBy: input.sortBy,
          limit: input.limit,
          items: [
            {
              ...baseTopEntities.items[0],
              userCount: 4.5,
            },
          ],
        } as unknown as CampaignAdminStatsTopEntities),
    });
    const setup = await createTestApp({ reader });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=interactionCount',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'Error',
      message: 'Campaign admin stats top entities response violates schema',
      retryable: false,
    });
  });
});
