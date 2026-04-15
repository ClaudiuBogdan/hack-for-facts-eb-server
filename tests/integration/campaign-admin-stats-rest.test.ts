import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  makeCampaignAdminStatsRoutes,
  type CampaignAdminStatsOverview,
  type CampaignAdminStatsReader,
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

function makeReader(
  implementation?: (campaignKey: string) => ReturnType<CampaignAdminStatsReader['getOverview']>
): CampaignAdminStatsReader & {
  getOverview: ReturnType<typeof vi.fn>;
} {
  return {
    getOverview: vi.fn(async (input) => {
      return implementation?.(input.campaignKey) ?? ok(baseOverview);
    }),
  };
}

async function createTestApp(options?: {
  reader?: CampaignAdminStatsReader;
  permissionAllowed?: boolean;
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

  it('returns 401 when authentication is missing', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/overview',
    });

    expect(response.statusCode).toBe(401);
    expect(setup.reader.getOverview).not.toHaveBeenCalled();
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

  it('returns 403 when the authenticated user lacks campaign-admin permission', async () => {
    const setup = await createTestApp({
      permissionAllowed: false,
    });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/overview',
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
    expect(setup.permissionAuthorizer.hasPermission).toHaveBeenCalledWith({
      userId: 'user_test_1',
      permissionName: 'campaign:funky_admin',
    });
    expect(setup.reader.getOverview).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown campaigns', async () => {
    const setup = await createTestApp();
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/unknown/stats/overview',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(setup.reader.getOverview).not.toHaveBeenCalled();
  });

  it('returns a sanitized overview response for authorized users', async () => {
    const reader = makeReader(async () =>
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
      } as unknown as CampaignAdminStatsOverview)
    );
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

  it('returns 500 when a count field violates the integer response contract', async () => {
    const reader = makeReader(async () =>
      ok({
        ...baseOverview,
        users: {
          ...baseOverview.users,
          totalUsers: 12.5,
        },
      } as unknown as CampaignAdminStatsOverview)
    );
    const setup = await createTestApp({ reader });
    app = setup.app;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns/funky/stats/overview',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: 'Error',
      message: 'Campaign admin stats overview response violates schema',
      retryable: false,
    });
  });
});
