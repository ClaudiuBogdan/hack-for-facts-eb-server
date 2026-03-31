import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeAnafForexebugDigestTriggerRoutes } from '@/modules/notification-delivery/index.js';

import {
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';

const testLogger = pinoLogger({ level: 'silent' });

describe('makeAnafForexebugDigestTriggerRoutes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it('returns 401 for malformed unicode keys with the same string length', async () => {
    app = fastifyLib({ logger: false });
    await app.register(
      makeAnafForexebugDigestTriggerRoutes({
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        deliveryRepo: makeFakeDeliveryRepo(),
        composeJobScheduler: { enqueue: async () => ok(undefined) },
        triggerApiKey: 'a'.repeat(32),
        logger: testLogger,
      })
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/trigger-digests/anaf-forexebug',
      headers: {
        'content-type': 'application/json',
        'x-notification-api-key': 'é'.repeat(32),
      },
      payload: {
        periodKey: '2026-03',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid API key' });
  });

  it('materializes digests and enqueues compose jobs for eligible notifications', async () => {
    const enqueue = vi.fn(async () => ok(undefined));

    app = fastifyLib({ logger: false });
    await app.register(
      makeAnafForexebugDigestTriggerRoutes({
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'newsletter-1',
              userId: 'user-1',
              entityCui: '123',
              notificationType: 'newsletter_entity_monthly',
            }),
            createTestNotification({
              id: 'alert-1',
              userId: 'user-1',
              notificationType: 'alert_series_analytics',
              config: { conditions: [], filter: {} },
            }),
          ],
        }),
        deliveryRepo: makeFakeDeliveryRepo(),
        composeJobScheduler: { enqueue },
        triggerApiKey: 'a'.repeat(32),
        logger: testLogger,
      })
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/trigger-digests/anaf-forexebug',
      headers: {
        'content-type': 'application/json',
        'x-notification-api-key': 'a'.repeat(32),
      },
      payload: {
        periodKey: '2026-03',
        userIds: ['user-1', 'user-2'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.periodKey).toBe('2026-03');
    expect(body.eligibleNotificationCount).toBe(2);
    expect(body.digestCount).toBe(1);
    expect(body.composeJobsEnqueued).toBe(1);
    expect(body.outboxIds).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
