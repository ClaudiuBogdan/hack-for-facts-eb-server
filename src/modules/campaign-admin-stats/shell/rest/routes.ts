import { Value } from '@sinclair/typebox/value';

import {
  makeCampaignAdminAuthorizationHook,
  resolveCampaignAdminPermissionAccess,
  type CampaignAdminPermissionAuthorizer,
} from '@/modules/campaign-admin/index.js';
import {
  getCampaignAdminReviewConfig,
  type CampaignAdminCampaignKey,
} from '@/modules/learning-progress/index.js';

import {
  CampaignAdminStatsOverviewSchema,
  CampaignAdminStatsOverviewResponseSchema,
  CampaignKeyParamsSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
} from './schemas.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { getCampaignAdminStatsOverview } from '../../core/usecases/get-campaign-admin-stats-overview.js';

import type { CampaignAdminStatsReader } from '../../core/ports.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

interface CampaignAdminStatsRouteConfig {
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly permissionName: string;
}

interface CampaignAdminStatsAccessContext {
  readonly userId: string;
  readonly config: CampaignAdminStatsRouteConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    campaignAdminStatsAccess: CampaignAdminStatsAccessContext | null;
  }
}

function getCampaignAdminStatsRouteConfig(
  campaignKey: string
): CampaignAdminStatsRouteConfig | null {
  const config = getCampaignAdminReviewConfig(campaignKey);
  if (config === null) {
    return null;
  }

  return {
    campaignKey: config.campaignKey,
    permissionName: config.permissionName,
  };
}

function getCampaignAdminStatsAccess(request: FastifyRequest): CampaignAdminStatsAccessContext {
  const access = request.campaignAdminStatsAccess;
  if (access === null) {
    throw new Error('Campaign admin stats access context missing from request');
  }

  return access;
}

function makeCampaignAdminStatsAuthHook(input: {
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: ReadonlySet<string>;
}) {
  return makeCampaignAdminAuthorizationHook<CampaignAdminStatsAccessContext>({
    setAccessContext(request, accessContext) {
      request.campaignAdminStatsAccess = accessContext;
    },
    authorize: async ({ campaignKey, userId }) => {
      return resolveCampaignAdminPermissionAccess({
        campaignKey,
        userId,
        permissionAuthorizer: input.permissionAuthorizer,
        enabledCampaignKeys: input.enabledCampaignKeys,
        getConfig: getCampaignAdminStatsRouteConfig,
        getPermissionName(config) {
          return config.permissionName;
        },
        buildAccessContext({ userId: accessUserId, config }) {
          return {
            userId: accessUserId,
            config,
          };
        },
        notFoundMessage: 'Campaign admin stats not found',
        forbiddenMessage: 'You do not have permission to access this campaign stats overview',
      });
    },
  });
}

export interface MakeCampaignAdminStatsRoutesDeps {
  readonly enabledCampaignKeys: readonly CampaignAdminCampaignKey[];
  readonly permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  readonly reader: CampaignAdminStatsReader;
}

export const makeCampaignAdminStatsRoutes = (
  deps: MakeCampaignAdminStatsRoutesDeps
): FastifyPluginAsync => {
  if (typeof deps.permissionAuthorizer.hasPermission !== 'function') {
    throw new Error('Campaign admin stats routes require a permission authorizer');
  }

  if (deps.enabledCampaignKeys.length === 0) {
    throw new Error('Campaign admin stats routes require at least one enabled campaign key.');
  }

  return async (fastify) => {
    const enabledCampaignKeys = new Set<string>(deps.enabledCampaignKeys);

    fastify.decorateRequest('campaignAdminStatsAccess', null);
    fastify.addHook(
      'preHandler',
      makeCampaignAdminStatsAuthHook({
        permissionAuthorizer: deps.permissionAuthorizer,
        enabledCampaignKeys,
      })
    );

    fastify.get<{ Params: CampaignKeyParams }>(
      '/api/v1/admin/campaigns/:campaignKey/stats/overview',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          response: {
            200: CampaignAdminStatsOverviewResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminStatsAccess(request);
        const result = await getCampaignAdminStatsOverview(
          {
            reader: deps.reader,
          },
          {
            campaignKey: access.config.campaignKey,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: false,
          });
        }

        const sanitizedOverview = Value.Clean(
          CampaignAdminStatsOverviewSchema,
          structuredClone(result.value)
        );
        if (!Value.Check(CampaignAdminStatsOverviewSchema, sanitizedOverview)) {
          throw new Error('Campaign admin stats overview response violates schema');
        }

        return reply.status(200).send({
          ok: true,
          data: sanitizedOverview,
        });
      }
    );
  };
};
