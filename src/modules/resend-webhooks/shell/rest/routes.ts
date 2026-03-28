import { fromThrowable } from 'neverthrow';

import type {
  ResendWebhookEmailEventsRepository,
  ResendWebhookSideEffect,
  SvixHeaders,
  WebhookVerifier,
} from '../../core/ports.js';
import type { ResendEmailWebhookEvent, StoredResendEmailEvent } from '../../core/types.js';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

export interface ResendWebhookRoutesDeps {
  webhookVerifier: WebhookVerifier;
  emailEventsRepo: ResendWebhookEmailEventsRepository;
  logger: Logger;
  sideEffect?: ResendWebhookSideEffect;
}

export const makeResendWebhookRoutes = (deps: ResendWebhookRoutesDeps): FastifyPluginAsync => {
  const { webhookVerifier, emailEventsRepo, logger, sideEffect } = deps;
  const log = logger.child({ routes: 'resend-webhooks' });

  const runSideEffect = async (
    event: ResendEmailWebhookEvent,
    storedEvent: StoredResendEmailEvent,
    svixId: string
  ): Promise<boolean> => {
    if (sideEffect === undefined) {
      return true;
    }

    try {
      await sideEffect.handle({
        event,
        storedEvent,
      });
      return true;
    } catch (error) {
      log.error({ svixId, error }, 'Resend webhook side effect failed');
      return false;
    }
  };

  return async (fastify) => {
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (request: FastifyRequest, body: string, done) => {
        (request as RequestWithRawBody).rawBody = body;
        // SECURITY: Use plain JSON parsing instead of the custom cache
        // deserializer which has revivers that convert {__decimal__: "..."} and
        // {__date__: "..."} markers into Decimal/Date objects. Webhook payloads
        // should not trigger custom type coercion.
        const safeJsonParse = fromThrowable(JSON.parse);
        const parsed = safeJsonParse(body);
        if (parsed.isErr()) {
          done(new Error('Invalid JSON in webhook body'), undefined);
          return;
        }
        done(null, parsed.value);
      }
    );

    fastify.post(
      '/api/v1/webhooks/resend',
      async (request: RequestWithRawBody, reply: FastifyReply) => {
        const svixId = request.headers['svix-id'] as string | undefined;
        const svixTimestamp = request.headers['svix-timestamp'] as string | undefined;
        const svixSignature = request.headers['svix-signature'] as string | undefined;

        if (svixId === undefined || svixTimestamp === undefined || svixSignature === undefined) {
          return reply.status(400).send({ error: 'Missing svix headers' });
        }

        if (request.rawBody === undefined) {
          log.error({ svixId }, 'Raw body unavailable for webhook verification');
          return reply.status(500).send({ error: 'Internal server error' });
        }

        const headers: SvixHeaders = {
          svixId,
          svixTimestamp,
          svixSignature,
        };

        const verifyResult = await webhookVerifier.verify(request.rawBody, headers);
        if (verifyResult.isErr()) {
          log.warn({ svixId, error: verifyResult.error }, 'Resend webhook verification failed');
          return reply.status(401).send({ error: 'Invalid signature' });
        }

        const event = verifyResult.value as ResendEmailWebhookEvent;
        const insertResult = await emailEventsRepo.insert({ svixId, event });

        if (insertResult.isErr()) {
          if (insertResult.error.type === 'DuplicateResendWebhookEvent') {
            const existingResult = await emailEventsRepo.findBySvixId(svixId);
            if (existingResult.isErr()) {
              log.error(
                { svixId, error: existingResult.error },
                'Failed to load duplicate resend webhook event'
              );
              return reply.status(500).send({ error: 'Internal server error' });
            }

            if (existingResult.value === null) {
              log.error({ svixId }, 'Duplicate resend webhook event missing stored row');
              return reply.status(500).send({ error: 'Internal server error' });
            }

            const replayed = await runSideEffect(event, existingResult.value, svixId);
            if (!replayed) {
              return reply.status(500).send({ error: 'Internal server error' });
            }

            return reply.status(200).send({ status: 'already_processed' });
          }

          log.error(
            { svixId, error: insertResult.error },
            'Failed to persist resend webhook event'
          );
          return reply.status(500).send({ error: 'Internal server error' });
        }

        const processed = await runSideEffect(event, insertResult.value, svixId);
        if (!processed) {
          return reply.status(500).send({ error: 'Internal server error' });
        }

        return reply.status(200).send({ status: 'processed' });
      }
    );
  };
};
