import fastifyLib, { type FastifyInstance } from 'fastify';
import pinoLogger from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  makeTriggerRoutes,
  type CollectJobPayload,
  type TriggerRoutesDeps,
} from '@/modules/notification-delivery/index.js';

import { createTestNotification, makeFakeExtendedNotificationsRepo } from '../../fixtures/fakes.js';

import type { ExtendedNotificationsRepository } from '@/modules/notification-delivery/core/ports.js';
import type { Notification } from '@/modules/notifications/core/types.js';
import type { Queue } from 'bullmq';

const testLogger = pinoLogger({ level: 'silent' });

const makeNotificationsRepo = (
  notifications: Notification[] = []
): ExtendedNotificationsRepository => makeFakeExtendedNotificationsRepo({ notifications });

const makeCollectQueue = (): Queue<CollectJobPayload> => {
  return {
    add: async () => ({}) as never,
  } as unknown as Queue<CollectJobPayload>;
};

const createTestApp = async (
  overrides: Partial<TriggerRoutesDeps> = {}
): Promise<FastifyInstance> => {
  const app = fastifyLib({ logger: false });

  await app.register(
    makeTriggerRoutes({
      collectQueue: makeCollectQueue(),
      notificationsRepo: makeNotificationsRepo(),
      triggerApiKey: 'a'.repeat(32),
      logger: testLogger,
      ...overrides,
    })
  );

  await app.ready();
  return app;
};

describe('makeTriggerRoutes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it('returns 401 for malformed unicode keys with the same string length', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/trigger',
      headers: {
        'content-type': 'application/json',
        'x-notification-api-key': 'é'.repeat(32),
      },
      payload: {
        notificationType: 'newsletter_entity_monthly',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid API key' });
  });

  it('does not enqueue a collect job when no eligible notifications are found', async () => {
    let addCalls = 0;
    app = await createTestApp({
      collectQueue: {
        add: async () => {
          addCalls += 1;
          return {} as never;
        },
      } as unknown as Queue<CollectJobPayload>,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/trigger',
      headers: {
        'content-type': 'application/json',
        'x-notification-api-key': 'a'.repeat(32),
      },
      payload: {
        notificationType: 'newsletter_entity_monthly',
        periodKey: '2026-03',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      notificationType: 'newsletter_entity_monthly',
      periodKey: '2026-03',
      dryRun: false,
      eligibleCount: 0,
      collectJobEnqueued: false,
    });
    expect(addCalls).toBe(0);
  });

  it('enqueues a collect job when eligible notifications are found', async () => {
    const add = vi.fn(async () => ({}) as never);
    app = await createTestApp({
      collectQueue: { add } as unknown as Queue<CollectJobPayload>,
      notificationsRepo: makeNotificationsRepo([
        createTestNotification({
          id: 'notification-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'notification-2',
          userId: 'user-2',
          entityCui: '456',
          notificationType: 'newsletter_entity_monthly',
        }),
      ]),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/trigger',
      headers: {
        'content-type': 'application/json',
        'x-notification-api-key': 'a'.repeat(32),
      },
      payload: {
        notificationType: 'newsletter_entity_monthly',
        periodKey: '2026-03',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      notificationType: 'newsletter_entity_monthly',
      periodKey: '2026-03',
      dryRun: false,
      eligibleCount: 2,
      collectJobEnqueued: true,
    });
    expect(add).toHaveBeenCalledWith(
      'collect',
      expect.objectContaining({
        notificationType: 'newsletter_entity_monthly',
        periodKey: '2026-03',
        notificationIds: ['notification-1', 'notification-2'],
      }),
      expect.objectContaining({
        jobId: 'collect:newsletter_entity_monthly:2026-03',
        removeOnComplete: true,
        removeOnFail: true,
      })
    );
  });

  it('honors force=true by ignoring existing outbox materialization', async () => {
    const add = vi.fn(async () => ({}) as never);
    app = await createTestApp({
      collectQueue: { add } as unknown as Queue<CollectJobPayload>,
      notificationsRepo: makeFakeExtendedNotificationsRepo({
        notifications: [
          createTestNotification({
            id: 'notification-1',
            userId: 'user-1',
            entityCui: '123',
            notificationType: 'newsletter_entity_monthly',
          }),
        ],
        deliveredNotificationIdsByPeriod: {
          '2026-03': ['notification-1'],
        },
      }),
    });

    const defaultResponse = await app.inject({
      method: 'POST',
      url: '/trigger',
      headers: {
        'content-type': 'application/json',
        'x-notification-api-key': 'a'.repeat(32),
      },
      payload: {
        notificationType: 'newsletter_entity_monthly',
        periodKey: '2026-03',
      },
    });

    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json()).toMatchObject({
      eligibleCount: 0,
      collectJobEnqueued: false,
    });

    const forceResponse = await app.inject({
      method: 'POST',
      url: '/trigger',
      headers: {
        'content-type': 'application/json',
        'x-notification-api-key': 'a'.repeat(32),
      },
      payload: {
        notificationType: 'newsletter_entity_monthly',
        periodKey: '2026-03',
        force: true,
      },
    });

    expect(forceResponse.statusCode).toBe(200);
    expect(forceResponse.json()).toMatchObject({
      eligibleCount: 1,
      collectJobEnqueued: true,
    });
    expect(add).toHaveBeenLastCalledWith(
      'collect',
      expect.objectContaining({
        notificationIds: ['notification-1'],
      }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^collect:newsletter_entity_monthly:2026-03:/u),
      })
    );
  });
});
