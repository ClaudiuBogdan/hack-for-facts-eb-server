/**
 * INS Module REST Routes
 *
 * POST /api/ins/dataset-requests: record a request for a dataset to be loaded.
 *
 * There is no GraphQL mutation surface in this server (the root `Mutation` type
 * is `{ _empty: String }` and no module extends it), so writes are exposed over
 * REST. The endpoint is public: anonymous requests are allowed, and an
 * authenticated caller's Clerk user id is attached when present.
 */

import {
  CreateDatasetRequestBodySchema,
  CreateDatasetRequestResponseSchema,
  ErrorResponseSchema,
  type CreateDatasetRequestBody,
} from './schemas.js';
import { isAuthenticated, type AuthContext } from '../../../auth/core/types.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { createInsDatasetRequest } from '../../core/usecases/create-ins-dataset-request.js';

import type { InsDatasetRequestRepository } from '../../core/ports.js';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  max: 10,
  timeWindow: '1 minute',
  errorResponseBuilder: (_request, context) => ({
    statusCode: context.statusCode,
    ok: false,
    error: 'RateLimitExceededError',
    message: 'Too many requests',
  }),
};

export interface MakeInsRoutesDeps {
  datasetRequestRepo: InsDatasetRequestRepository;
  rateLimit?: RateLimitOptions;
}

/**
 * `request.auth` is populated by the global auth preHandler, which is only
 * registered when an auth provider is configured. Treat its absence as an
 * anonymous caller rather than assuming the decorator is always present.
 */
const getClerkUserId = (request: FastifyRequest): string | undefined => {
  const auth = request.auth as AuthContext | undefined;
  if (auth === undefined || !isAuthenticated(auth)) {
    return undefined;
  }
  return auth.userId;
};

export const makeInsRoutes = (deps: MakeInsRoutesDeps): FastifyPluginAsync => {
  const { datasetRequestRepo, rateLimit = DEFAULT_RATE_LIMIT } = deps;

  return async (fastify) => {
    fastify.post<{ Body: CreateDatasetRequestBody }>(
      '/api/ins/dataset-requests',
      {
        config: {
          rateLimit,
        },
        schema: {
          body: CreateDatasetRequestBodySchema,
          response: {
            201: CreateDatasetRequestResponseSchema,
            400: ErrorResponseSchema,
            429: ErrorResponseSchema,
            500: ErrorResponseSchema,
            504: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { datasetCode, siruta, contactEmail, note } = request.body;
        const clerkUserId = getClerkUserId(request);

        const result = await createInsDatasetRequest(
          { datasetRequestRepo },
          {
            datasetCode,
            ...(siruta !== undefined ? { siruta } : {}),
            ...(contactEmail !== undefined ? { contactEmail } : {}),
            ...(note !== undefined ? { note } : {}),
            ...(clerkUserId !== undefined ? { clerkUserId } : {}),
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          if (status >= 500) {
            request.log.error({ err: result.error }, '[INS] create dataset request failed');
          }
          return reply.status(status).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(201).send({
          ok: true,
          data: {
            id: result.value.id,
            datasetCode: result.value.dataset_code,
          },
        });
      }
    );
  };
};
