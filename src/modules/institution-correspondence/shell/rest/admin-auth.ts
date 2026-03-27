import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

export const INSTITUTION_CORRESPONDENCE_ADMIN_API_KEY_HEADER =
  'x-institution-correspondence-admin-api-key';

export interface InstitutionCorrespondenceAdminAuthConfig {
  apiKey: string;
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

export const makeInstitutionCorrespondenceAdminAuthHook = (
  config: InstitutionCorrespondenceAdminAuthConfig
) => {
  return function institutionCorrespondenceAdminAuthHook(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    const providedKey = request.headers[INSTITUTION_CORRESPONDENCE_ADMIN_API_KEY_HEADER];
    if (typeof providedKey !== 'string') {
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'X-Institution-Correspondence-Admin-Api-Key header required',
      });
      return;
    }

    if (!verifyApiKey(providedKey, config.apiKey)) {
      reply.status(401).send({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
      return;
    }

    done();
  };
};
