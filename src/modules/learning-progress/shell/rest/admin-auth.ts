import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

export const LEARNING_PROGRESS_REVIEW_API_KEY_HEADER = 'x-learning-progress-review-api-key';

export interface LearningProgressAdminReviewAuthConfig {
  apiKey: string | undefined;
}

function verifyApiKey(providedKey: string, configuredKey: string): boolean {
  const configuredBuffer = Buffer.from(configuredKey, 'utf-8');
  const providedBuffer = Buffer.from(providedKey, 'utf-8');

  if (configuredBuffer.length !== providedBuffer.length) {
    timingSafeEqual(configuredBuffer, configuredBuffer);
    return false;
  }

  return timingSafeEqual(configuredBuffer, providedBuffer);
}

export function makeLearningProgressAdminReviewAuthHook(
  config: LearningProgressAdminReviewAuthConfig
) {
  return function learningProgressAdminReviewAuthHook(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    const configuredApiKey = config.apiKey;

    if (configuredApiKey === undefined || configuredApiKey === '') {
      request.log.warn('Learning progress review API key not configured - rejecting request');
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Learning progress review API key not configured',
        retryable: false,
      });
      return;
    }

    const providedKey = request.headers[LEARNING_PROGRESS_REVIEW_API_KEY_HEADER];
    if (typeof providedKey !== 'string') {
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'X-Learning-Progress-Review-Api-Key header required',
        retryable: false,
      });
      return;
    }

    if (!verifyApiKey(providedKey, configuredApiKey)) {
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
        retryable: false,
      });
      return;
    }

    done();
  };
}
