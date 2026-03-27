import { isAuthenticated } from '@/modules/auth/core/types.js';
import { requireAuthHandler } from '@/modules/auth/shell/middleware/fastify-auth.js';

import { formatThread } from './formatters.js';
import {
  ErrorResponseSchema,
  PlatformSendBodySchema,
  PrepareSelfSendBodySchema,
  PrepareSelfSendResponseSchema,
  ThreadResponseSchema,
  type PrepareSelfSendBody,
  type PlatformSendBody,
} from './schemas.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { prepareSelfSend } from '../../core/usecases/prepare-self-send.js';
import { sendPlatformRequest } from '../../core/usecases/send-platform-request.js';

import type {
  CorrespondenceEmailSender,
  CorrespondenceTemplateRenderer,
  InstitutionCorrespondenceRepository,
} from '../../core/ports.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

export interface InstitutionCorrespondenceRoutesDeps {
  repo: InstitutionCorrespondenceRepository;
  emailSender: CorrespondenceEmailSender;
  templateRenderer: CorrespondenceTemplateRenderer;
  auditCcRecipients: string[];
  platformBaseUrl: string;
  captureAddress: string;
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    ok: false,
    error: 'Unauthorized',
    message: 'Authentication required',
  });
}

export const makeInstitutionCorrespondenceRoutes = (
  deps: InstitutionCorrespondenceRoutesDeps
): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.post<{ Body: PlatformSendBody }>(
      '/api/v1/institution-correspondence/public-debate/platform-send',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: PlatformSendBodySchema,
          response: {
            200: ThreadResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            409: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const result = await sendPlatformRequest(
          {
            repo: deps.repo,
            emailSender: deps.emailSender,
            templateRenderer: deps.templateRenderer,
            auditCcRecipients: deps.auditCcRecipients,
            platformBaseUrl: deps.platformBaseUrl,
            captureAddress: deps.captureAddress,
          },
          {
            ownerUserId: request.auth.userId,
            entityCui: request.body.entityCui,
            institutionEmail: request.body.institutionEmail,
            requesterOrganizationName: request.body.requesterOrganizationName ?? null,
            budgetPublicationDate: request.body.budgetPublicationDate ?? null,
            consentCapturedAt: request.body.consentCapturedAt ?? null,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 409 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            created: result.value.created,
            thread: formatThread(result.value.thread),
          },
        });
      }
    );

    fastify.post<{ Body: PrepareSelfSendBody }>(
      '/api/v1/institution-correspondence/public-debate/self-send/prepare',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: PrepareSelfSendBodySchema,
          response: {
            200: PrepareSelfSendResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            409: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const result = await prepareSelfSend(
          {
            templateRenderer: deps.templateRenderer,
            auditCcRecipients: deps.auditCcRecipients,
            captureAddress: deps.captureAddress,
          },
          {
            ownerUserId: request.auth.userId,
            entityCui: request.body.entityCui,
            institutionEmail: request.body.institutionEmail,
            requesterOrganizationName: request.body.requesterOrganizationName ?? null,
            budgetPublicationDate: request.body.budgetPublicationDate ?? null,
            consentCapturedAt: request.body.consentCapturedAt ?? null,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 409 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            created: result.value.created,
            existingThread:
              result.value.existingThread !== null
                ? formatThread(result.value.existingThread)
                : null,
            threadKey: result.value.threadKey,
            captureAddress: result.value.captureAddress,
            subject: result.value.subject,
            body: result.value.body,
            cc: result.value.cc,
          },
        });
      }
    );
  };
};
