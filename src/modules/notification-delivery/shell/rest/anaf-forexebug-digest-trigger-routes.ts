import { randomUUID } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';

import { createTriggerApiKeyPreHandler } from './trigger-auth.js';
import { materializeAnafForexebugDigests } from '../../core/usecases/materialize-anaf-forexebug-digests.js';

import type {
  ComposeJobScheduler,
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '../../core/ports.js';
import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';

const AnafForexebugDigestTriggerRequestSchema = Type.Object({
  periodKey: Type.String({ minLength: 4, maxLength: 10 }),
  userIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 1000 })),
  dryRun: Type.Optional(Type.Boolean({ default: false })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10000 })),
});

type AnafForexebugDigestTriggerRequest = Static<typeof AnafForexebugDigestTriggerRequestSchema>;

const AnafForexebugDigestTriggerResponseSchema = Type.Object({
  runId: Type.String(),
  digestType: Type.Literal('anaf_forexebug_digest'),
  periodKey: Type.String(),
  dryRun: Type.Boolean(),
  eligibleNotificationCount: Type.Number(),
  digestCount: Type.Number(),
  composeJobsEnqueued: Type.Number(),
  outboxIds: Type.Array(Type.String()),
});

export interface AnafForexebugDigestTriggerRoutesDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
  triggerApiKey: string;
  logger: Logger;
}

/**
 * Queue + outbox bundle design reference:
 * docs/specs/specs-202603301900-bundle-delivery-with-queue-and-outbox.md
 */
export const makeAnafForexebugDigestTriggerRoutes = (
  deps: AnafForexebugDigestTriggerRoutesDeps
): FastifyPluginAsync => {
  const { notificationsRepo, deliveryRepo, composeJobScheduler, triggerApiKey, logger } = deps;
  const log = logger.child({ routes: 'anaf-forexebug-digest-trigger' });
  const triggerApiKeyBuffer = Buffer.from(triggerApiKey, 'utf-8');

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync pattern requires async
  return async (fastify) => {
    const authenticateApiKey = createTriggerApiKeyPreHandler(triggerApiKeyBuffer, log);

    fastify.post<{ Body: AnafForexebugDigestTriggerRequest }>(
      '/trigger-digests/anaf-forexebug',
      {
        preHandler: authenticateApiKey,
        schema: {
          body: AnafForexebugDigestTriggerRequestSchema,
          response: { 200: AnafForexebugDigestTriggerResponseSchema },
        },
      },
      async (request, reply) => {
        const runId = randomUUID();
        const result = await materializeAnafForexebugDigests(
          {
            notificationsRepo,
            deliveryRepo,
            composeJobScheduler,
          },
          {
            runId,
            periodKey: request.body.periodKey,
            ...(request.body.userIds !== undefined ? { userIds: request.body.userIds } : {}),
            dryRun: request.body.dryRun === true,
            ...(request.body.limit !== undefined ? { limit: request.body.limit } : {}),
          }
        );

        if (result.isErr()) {
          log.error({ error: result.error, runId }, 'Failed to trigger ANAF / Forexebug digest');
          return reply.status(500).send({ error: 'Failed to trigger ANAF / Forexebug digest' });
        }

        return reply.send(result.value);
      }
    );
  };
};
