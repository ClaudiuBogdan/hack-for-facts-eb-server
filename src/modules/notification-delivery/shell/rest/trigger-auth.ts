import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

export const isValidTriggerApiKey = (
  apiKey: string | string[] | undefined,
  expectedApiKeyBuffer: Buffer
): boolean => {
  if (typeof apiKey !== 'string') {
    return false;
  }

  const providedApiKeyBuffer = Buffer.from(apiKey, 'utf-8');
  if (providedApiKeyBuffer.length !== expectedApiKeyBuffer.length) {
    timingSafeEqual(expectedApiKeyBuffer, expectedApiKeyBuffer);
    return false;
  }

  return timingSafeEqual(providedApiKeyBuffer, expectedApiKeyBuffer);
};

export const createTriggerApiKeyPreHandler = (triggerApiKeyBuffer: Buffer, log: Logger) => {
  return (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
    const apiKey = request.headers['x-notification-api-key'];
    const isValid = isValidTriggerApiKey(apiKey, triggerApiKeyBuffer);

    if (!isValid) {
      log.warn({ hasKey: Boolean(apiKey) }, 'Invalid or missing API key');
      reply.status(401).send({ error: 'Invalid API key' });
      return;
    }

    done();
  };
};
