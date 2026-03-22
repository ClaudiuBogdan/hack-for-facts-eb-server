import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import {
  makeTriggerRoutes,
  type CollectJobPayload,
  type TriggerRoutesDeps,
} from '@/modules/notification-delivery/index.js';

import type { ExtendedNotificationsRepository } from '@/modules/notification-delivery/core/ports.js';
import type { Queue } from 'bullmq';

const testLogger = pinoLogger({ level: 'silent' });

const makeNotificationsRepo = (): ExtendedNotificationsRepository => ({
  findById: async () => ok(null),
  findEligibleForDelivery: async () => ok([]),
  deactivate: async () => ok(undefined),
});

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
});
