import {
  CampaignSubscriptionStatsParamsSchema,
  CampaignSubscriptionStatsResponseSchema,
  ErrorResponseSchema,
  type CampaignSubscriptionStatsParams,
} from './schemas.js';
import { getHttpStatusForError } from '../../core/errors.js';

import type { CampaignSubscriptionStatsReader } from '../../core/ports.js';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';

const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  max: 60,
  timeWindow: '1 minute',
  errorResponseBuilder: (_request, context) => ({
    statusCode: context.statusCode,
    ok: false,
    error: 'RateLimitExceededError',
    message: 'Too many requests',
  }),
};

const CACHE_CONTROL_HEADER = 'public, max-age=60, stale-while-revalidate=300';

export interface MakeCampaignSubscriptionStatsRoutesDeps {
  reader: CampaignSubscriptionStatsReader;
  rateLimit?: RateLimitOptions;
}

export const makeCampaignSubscriptionStatsRoutes = (
  deps: MakeCampaignSubscriptionStatsRoutesDeps
): FastifyPluginAsync => {
  const { reader, rateLimit = DEFAULT_RATE_LIMIT } = deps;

  return async (fastify) => {
    fastify.get<{ Params: CampaignSubscriptionStatsParams }>(
      '/api/v1/campaigns/:campaignId/subscription-stats',
      {
        config: {
          rateLimit,
        },
        schema: {
          params: CampaignSubscriptionStatsParamsSchema,
          response: {
            200: CampaignSubscriptionStatsResponseSchema,
            404: ErrorResponseSchema,
            429: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const campaignId = request.params.campaignId.trim().toLowerCase();
        const result = await reader.getByCampaignId(campaignId);

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        reply.header('Cache-Control', CACHE_CONTROL_HEADER);

        return reply.status(200).send({
          total: result.value.total,
          per_uat: result.value.perUat.map((entry) => ({
            siruta_code: entry.sirutaCode,
            uat_name: entry.uatName,
            count: entry.count,
          })),
        });
      }
    );
  };
};
