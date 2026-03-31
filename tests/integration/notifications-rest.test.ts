/**
 * Integration tests for Notifications REST API
 *
 * Tests cover:
 * - Authentication handling
 * - Route behavior (request/response mapping)
 * - Error responses
 * - HTTP status codes
 *
 * Uses in-memory fakes for repositories and the test auth provider.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import { sha256Hasher } from '@/modules/notifications/shell/crypto/hasher.js';
import { makeNotificationRoutes } from '@/modules/notifications/shell/rest/routes.js';

import {
  makeFakeNotificationsRepo,
  makeFakeDeliveriesRepo,
  makeFakeTokenSigner,
  createTestNotification,
  createTestDelivery,
} from '../fixtures/fakes.js';

import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import type {
  NotificationsRepository,
  DeliveriesRepository,
} from '@/modules/notifications/core/ports.js';

/**
 * Creates a test Fastify app with notification routes.
 */
const defaultTokenSigner = makeFakeTokenSigner();

const createTestApp = async (options: {
  notificationsRepo?: NotificationsRepository;
  deliveriesRepo?: DeliveriesRepository;
  tokenSigner?: UnsubscribeTokenSigner;
}) => {
  const { provider } = createTestAuthProvider();

  // HMAC-signed unsubscribe tokens are ~100+ chars (base64url of userId + HMAC).
  // Fastify's default maxParamLength is 100; increase to support real tokens.
  const app = fastifyLib({
    logger: false,
    routerOptions: {
      maxParamLength: 512,
    },
  });

  // Add custom error handler to format all errors consistently
  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    void reply.status(statusCode).send({
      ok: false,
      error: error.code ?? error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
    });
  });

  // Add auth middleware
  app.addHook('preHandler', makeAuthMiddleware({ authProvider: provider }));

  // Register notification routes
  const notificationsRepo = options.notificationsRepo ?? makeFakeNotificationsRepo();
  const deliveriesRepo = options.deliveriesRepo ?? makeFakeDeliveriesRepo();
  const tokenSigner = options.tokenSigner ?? defaultTokenSigner;

  await app.register(
    makeNotificationRoutes({
      notificationsRepo,
      deliveriesRepo,
      tokenSigner,
      hasher: sha256Hasher,
    })
  );

  await app.ready();
  return app;
};

describe('Notifications REST API', () => {
  let app: FastifyInstance;
  let testAuth: ReturnType<typeof createTestAuthProvider>;

  beforeAll(() => {
    testAuth = createTestAuthProvider();
  });

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('authentication', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
      app = await createTestApp({});
    });

    it('returns 401 when no auth token provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when invalid auth token provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('allows access with valid token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/notifications (newsletter)', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
      app = await createTestApp({});
    });

    it('creates newsletter subscription', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          notificationType: 'newsletter_entity_monthly',
          entityCui: '1234567',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data.notificationType).toBe('newsletter_entity_monthly');
      expect(body.data.entityCui).toBe('1234567');
      expect(body.data.isActive).toBe(true);
    });

    it('returns 400 when entityCui is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          notificationType: 'newsletter_entity_monthly',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/notifications (static alert)', () => {
    beforeEach(async () => {
      if (app != null) await app.close();
      app = await createTestApp({});
    });

    it('creates static alert subscription', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          notificationType: 'alert_series_static',
          entityCui: null,
          config: {
            title: 'CPI Monitor',
            conditions: [],
            datasetId: 'ro.economics.cpi.yearly',
          },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data.notificationType).toBe('alert_series_static');
      expect(body.data.config).toBeDefined();
    });

    it('returns 400 when config is invalid for static alert', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          notificationType: 'alert_series_static',
          entityCui: null,
          config: {
            title: 'Invalid',
            conditions: [],
            // Missing datasetId
          },
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/notifications', () => {
    it('returns empty array when no subscriptions exist', async () => {
      if (app != null) await app.close();
      app = await createTestApp({});

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns user subscriptions', async () => {
      const notifications = [
        createTestNotification({
          id: 'n1',
          userId: testAuth.userIds.user1,
          notificationType: 'newsletter_entity_monthly',
          entityCui: '1234567',
        }),
        createTestNotification({
          id: 'n2',
          userId: testAuth.userIds.user2, // Different user
        }),
      ];

      if (app != null) await app.close();
      app = await createTestApp({
        notificationsRepo: makeFakeNotificationsRepo({ notifications }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('n1');
    });
  });

  describe('GET /api/v1/notifications/entity/:cui', () => {
    it('returns subscriptions for specific entity', async () => {
      const notifications = [
        createTestNotification({
          id: 'n1',
          userId: testAuth.userIds.user1,
          entityCui: '1234567',
        }),
        createTestNotification({
          id: 'n2',
          userId: testAuth.userIds.user1,
          entityCui: '7654321', // Different entity
        }),
      ];

      if (app != null) await app.close();
      app = await createTestApp({
        notificationsRepo: makeFakeNotificationsRepo({ notifications }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/entity/1234567',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].entityCui).toBe('1234567');
    });
  });

  describe('PUT /api/v1/notifications/:id', () => {
    // Test UUIDs for notification IDs
    const testUuid1 = '11111111-1111-1111-1111-111111111111';
    const testUuid2 = '22222222-2222-2222-2222-222222222222';

    it('updates subscription status', async () => {
      const notification = createTestNotification({
        id: testUuid1,
        userId: testAuth.userIds.user1,
        isActive: true,
      });

      if (app != null) await app.close();
      app = await createTestApp({
        notificationsRepo: makeFakeNotificationsRepo({ notifications: [notification] }),
      });

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/notifications/${testUuid1}`,
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          isActive: false,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data.isActive).toBe(false);
    });

    it('returns 404 when notification does not exist', async () => {
      if (app != null) await app.close();
      app = await createTestApp({});

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/notifications/00000000-0000-0000-0000-000000000000',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          isActive: false,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when user does not own notification', async () => {
      const notification = createTestNotification({
        id: testUuid2,
        userId: testAuth.userIds.user2, // Owned by user2
      });

      if (app != null) await app.close();
      app = await createTestApp({
        notificationsRepo: makeFakeNotificationsRepo({ notifications: [notification] }),
      });

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/notifications/${testUuid2}`,
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`, // user1 trying to update
          'content-type': 'application/json',
        },
        payload: {
          isActive: false,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('supports PATCH method for updates', async () => {
      const notification = createTestNotification({
        id: testUuid1,
        userId: testAuth.userIds.user1,
        isActive: true,
      });

      if (app != null) await app.close();
      app = await createTestApp({
        notificationsRepo: makeFakeNotificationsRepo({ notifications: [notification] }),
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/${testUuid1}`,
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
          'content-type': 'application/json',
        },
        payload: {
          isActive: false,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data.isActive).toBe(false);
    });
  });

  describe('DELETE /api/v1/notifications/:id', () => {
    // Test UUIDs for notification IDs
    const testUuid3 = '33333333-3333-3333-3333-333333333333';
    const testUuid4 = '44444444-4444-4444-4444-444444444444';

    it('deletes subscription', async () => {
      const notification = createTestNotification({
        id: testUuid3,
        userId: testAuth.userIds.user1,
      });

      if (app != null) await app.close();
      app = await createTestApp({
        notificationsRepo: makeFakeNotificationsRepo({ notifications: [notification] }),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/notifications/${testUuid3}`,
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    });

    it('returns 404 when notification does not exist', async () => {
      if (app != null) await app.close();
      app = await createTestApp({});

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/notifications/00000000-0000-0000-0000-000000000000',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when user does not own notification', async () => {
      const notification = createTestNotification({
        id: testUuid4,
        userId: testAuth.userIds.user2,
      });

      if (app != null) await app.close();
      app = await createTestApp({
        notificationsRepo: makeFakeNotificationsRepo({ notifications: [notification] }),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/notifications/${testUuid4}`,
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/notifications/deliveries', () => {
    it('returns delivery history', async () => {
      const deliveries = [
        createTestDelivery({
          id: 'd1',
          userId: testAuth.userIds.user1,
          scopeKey: '2024-01',
          toEmail: 'user1@example.com',
        }),
        createTestDelivery({
          id: 'd2',
          userId: testAuth.userIds.user1,
          scopeKey: '2024-02',
        }),
      ];

      if (app != null) await app.close();
      app = await createTestApp({
        deliveriesRepo: makeFakeDeliveriesRepo({ deliveries }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/deliveries',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).not.toHaveProperty('toEmail');
      expect(body.data[0]).toHaveProperty('status');
    });

    it('returns notificationId null when a delivery has no single source reference', async () => {
      const deliveries = [
        createTestDelivery({
          id: 'd-null',
          userId: testAuth.userIds.user1,
          notificationId: null,
          deliveryKey: `${testAuth.userIds.user1}:no-reference:2024-01`,
          scopeKey: '2024-01',
        }),
      ];

      if (app != null) await app.close();
      app = await createTestApp({
        deliveriesRepo: makeFakeDeliveriesRepo({ deliveries }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/deliveries',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual([
        expect.objectContaining({
          id: 'd-null',
          notificationId: null,
        }),
      ]);
    });

    it('supports pagination parameters', async () => {
      const deliveries = Array.from({ length: 10 }, (_, i) =>
        createTestDelivery({
          id: `d${String(i)}`,
          userId: testAuth.userIds.user1,
          sentAt: new Date(Date.now() - i * 1000),
        })
      );

      if (app != null) await app.close();
      app = await createTestApp({
        deliveriesRepo: makeFakeDeliveriesRepo({ deliveries }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/deliveries?limit=3&offset=2',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(3);
    });

    it('ignores non-numeric pagination parameters', async () => {
      const deliveries = Array.from({ length: 10 }, (_, i) =>
        createTestDelivery({
          id: `d${String(i)}`,
          userId: testAuth.userIds.user1,
          sentAt: new Date(Date.now() - i * 1000),
        })
      );

      if (app != null) await app.close();
      app = await createTestApp({
        deliveriesRepo: makeFakeDeliveriesRepo({ deliveries }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/deliveries?limit=abc&offset=def',
        headers: {
          authorization: `Bearer ${testAuth.tokens.user1}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(10);
    });
  });

  describe('POST /api/v1/notifications/unsubscribe/:token (no auth)', () => {
    it('unsubscribes via valid HMAC token without authentication', async () => {
      const signedToken = defaultTokenSigner.sign(testAuth.userIds.user1);

      if (app != null) await app.close();
      app = await createTestApp({});

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/notifications/unsubscribe/${signedToken}`,
        // Note: No authorization header - this endpoint is public
      });

      // RFC 8058: One-click unsubscribe returns empty body with 200
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('');
    });

    it('returns 200 with empty body for invalid/tampered token (prevents enumeration)', async () => {
      if (app != null) await app.close();
      app = await createTestApp({});

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/notifications/unsubscribe/invalid-token-garbage`,
      });

      // RFC 8058: One-click always returns 200 to prevent token enumeration
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('');
    });

    it('is idempotent (calling twice returns 200 both times)', async () => {
      const signedToken = defaultTokenSigner.sign(testAuth.userIds.user1);

      if (app != null) await app.close();
      app = await createTestApp({});

      const response1 = await app.inject({
        method: 'POST',
        url: `/api/v1/notifications/unsubscribe/${signedToken}`,
      });
      expect(response1.statusCode).toBe(200);
      expect(response1.body).toBe('');

      const response2 = await app.inject({
        method: 'POST',
        url: `/api/v1/notifications/unsubscribe/${signedToken}`,
      });
      expect(response2.statusCode).toBe(200);
      expect(response2.body).toBe('');
    });
  });
});
