import { createHash } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import { fromThrowable } from 'neverthrow';

import { parseClerkWebhookEvent } from '../../core/usecases/parse-clerk-webhook-event.js';

import type {
  ClerkWebhookEventVerifiedHandler,
  ClerkWebhookVerifier,
  SvixHeaders,
} from '../../core/ports.js';
import type { ClerkWebhookEvent } from '../../core/types.js';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

export interface ClerkWebhookRoutesDeps {
  webhookVerifier: ClerkWebhookVerifier;
  logger: Logger;
  onEventVerified?: ClerkWebhookEventVerifiedHandler;
}

const WebhookSuccessResponseSchema = Type.Object({
  status: Type.Literal('received'),
});

const WebhookErrorResponseSchema = Type.Object({
  error: Type.String(),
});

const safeJsonParse = fromThrowable(JSON.parse);

const getEventDataId = (event: ClerkWebhookEvent): string | undefined => {
  const value = event.data['id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const hashLogValue = (value: string): string => createHash('sha256').update(value).digest('hex');

const getEventDataIdLogFields = (
  event: ClerkWebhookEvent
): { eventDataId?: string; eventDataIdHash?: string } => {
  const eventDataId = getEventDataId(event);
  if (eventDataId === undefined) {
    return {};
  }

  if (event.type === 'user.deleted') {
    return { eventDataIdHash: hashLogValue(eventDataId) };
  }

  return { eventDataId };
};

export const makeClerkWebhookRoutes = (deps: ClerkWebhookRoutesDeps): FastifyPluginAsync => {
  const { webhookVerifier, logger, onEventVerified } = deps;
  const log = logger.child({ routes: 'clerk-webhooks' });

  return async (fastify) => {
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (request: FastifyRequest, body: string, done) => {
        (request as RequestWithRawBody).rawBody = body;
        done(null, body);
      }
    );

    fastify.post(
      '/api/v1/webhooks/clerk',
      {
        schema: {
          response: {
            200: WebhookSuccessResponseSchema,
            400: WebhookErrorResponseSchema,
            401: WebhookErrorResponseSchema,
            500: WebhookErrorResponseSchema,
          },
        },
      },
      async (request: RequestWithRawBody, reply: FastifyReply) => {
        const svixId = request.headers['svix-id'] as string | undefined;
        const svixTimestamp = request.headers['svix-timestamp'] as string | undefined;
        const svixSignature = request.headers['svix-signature'] as string | undefined;

        if (svixId === undefined || svixTimestamp === undefined || svixSignature === undefined) {
          return reply.status(400).send({ error: 'Missing svix headers' });
        }

        if (request.rawBody === undefined) {
          log.error({ svixId }, 'Raw body unavailable for Clerk webhook verification');
          return reply.status(500).send({ error: 'Internal server error' });
        }

        const parseResult = safeJsonParse(request.rawBody);
        if (parseResult.isErr()) {
          return reply.status(400).send({ error: 'Invalid JSON in webhook body' });
        }

        const headers: SvixHeaders = {
          svixId,
          svixTimestamp,
          svixSignature,
        };

        const verifyResult = await webhookVerifier.verify(request.rawBody, headers);
        if (verifyResult.isErr()) {
          log.warn({ svixId, error: verifyResult.error.type }, 'Clerk webhook verification failed');
          return reply.status(401).send({ error: 'Invalid signature' });
        }

        const eventResult = parseClerkWebhookEvent(verifyResult.value);
        if (eventResult.isErr()) {
          log.warn(
            { svixId, error: eventResult.error.message },
            'Clerk webhook payload validation failed'
          );
          return reply.status(400).send({ error: 'Invalid webhook payload' });
        }

        const event = eventResult.value;

        log.info(
          {
            svixId,
            eventType: event.type,
            instanceId: event.instance_id,
            ...getEventDataIdLogFields(event),
          },
          'Clerk webhook received'
        );

        if (onEventVerified !== undefined) {
          try {
            await onEventVerified({ event, svixId });
          } catch (error) {
            log.error({ error, svixId, eventType: event.type }, 'Clerk webhook side effect failed');
            return reply.status(500).send({ error: 'Internal server error' });
          }
        }

        return reply.status(200).send({ status: 'received' });
      }
    );
  };
};
