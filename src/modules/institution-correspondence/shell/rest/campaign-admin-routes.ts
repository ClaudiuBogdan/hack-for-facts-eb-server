import { Value } from '@sinclair/typebox/value';

import { FUNKY_CAMPAIGN_ADMIN_PERMISSION, FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import { deserialize } from '@/infra/cache/serialization.js';
import {
  makeCampaignAdminAuthorizationHook,
  resolveCampaignAdminPermissionAccess,
  type CampaignAdminPermissionAuthorizer,
} from '@/modules/campaign-admin/index.js';

import {
  formatCampaignAdminThreadDetail,
  formatCampaignAdminThreadListItem,
} from './campaign-admin-formatters.js';
import {
  CampaignAdminInstitutionThreadCursorSchema,
  CampaignAdminInstitutionThreadDetailResponseSchema,
  CampaignAdminInstitutionThreadParamsSchema,
  CampaignAdminInstitutionThreadResponseBodySchema,
  CampaignAdminInstitutionThreadResponseCreateResponseSchema,
  CampaignAdminInstitutionThreadsListQuerySchema,
  CampaignAdminInstitutionThreadsListResponseSchema,
  CampaignKeyParamsSchema,
  ErrorResponseSchema,
  type CampaignAdminInstitutionThreadParams,
  type CampaignAdminInstitutionThreadResponseBody,
  type CampaignAdminInstitutionThreadsListQuery,
  type CampaignKeyParams,
} from './campaign-admin-schemas.js';
import { getHttpStatusForError, type InstitutionCorrespondenceError } from '../../core/errors.js';
import { appendCampaignAdminThreadResponse } from '../../core/usecases/append-campaign-admin-thread-response.js';
import { getCampaignAdminThread } from '../../core/usecases/get-campaign-admin-thread.js';
import { normalizeOptionalString } from '../../core/usecases/helpers.js';
import { listCampaignAdminThreads } from '../../core/usecases/list-campaign-admin-threads.js';

import type { InstitutionCorrespondenceRepository } from '../../core/ports.js';
import type { CampaignAdminThreadStateGroup } from '../../core/types.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from 'fastify';

const DEFAULT_LIST_LIMIT = 50;
const ALLOWED_QUERY_KEYS = new Set<string>([
  'stateGroup',
  'threadState',
  'responseStatus',
  'query',
  'entityCui',
  'updatedAtFrom',
  'updatedAtTo',
  'latestResponseAtFrom',
  'latestResponseAtTo',
  'cursor',
  'limit',
]);

interface CampaignAdminInstitutionThreadsRouteConfig {
  readonly campaignKey: typeof FUNKY_CAMPAIGN_KEY;
  readonly permissionName: string;
}

interface CampaignAdminInstitutionThreadsAccessContext {
  readonly userId: string;
  readonly config: CampaignAdminInstitutionThreadsRouteConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    campaignAdminInstitutionThreadsAccess: CampaignAdminInstitutionThreadsAccessContext | null;
  }
}

const CAMPAIGN_ADMIN_INSTITUTION_THREADS_ROUTE_CONFIGS: Readonly<
  Record<typeof FUNKY_CAMPAIGN_KEY, CampaignAdminInstitutionThreadsRouteConfig>
> = {
  [FUNKY_CAMPAIGN_KEY]: {
    campaignKey: FUNKY_CAMPAIGN_KEY,
    permissionName: FUNKY_CAMPAIGN_ADMIN_PERMISSION,
  },
};

function getCampaignAdminInstitutionThreadsRouteConfig(
  campaignKey: string
): CampaignAdminInstitutionThreadsRouteConfig | null {
  if (campaignKey === FUNKY_CAMPAIGN_KEY) {
    return CAMPAIGN_ADMIN_INSTITUTION_THREADS_ROUTE_CONFIGS[FUNKY_CAMPAIGN_KEY];
  }

  return null;
}

function getCampaignAdminInstitutionThreadsAccess(
  request: FastifyRequest
): CampaignAdminInstitutionThreadsAccessContext {
  const access = request.campaignAdminInstitutionThreadsAccess;
  if (access === null) {
    throw new Error('Campaign admin institution threads access context missing from request');
  }

  return access;
}

function makeCampaignAdminInstitutionThreadsAuthHook(input: {
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: ReadonlySet<string>;
}) {
  return makeCampaignAdminAuthorizationHook<CampaignAdminInstitutionThreadsAccessContext>({
    setAccessContext(request, accessContext) {
      request.campaignAdminInstitutionThreadsAccess = accessContext;
    },
    authorize: async ({ campaignKey, userId }) => {
      return resolveCampaignAdminPermissionAccess({
        campaignKey,
        userId,
        permissionAuthorizer: input.permissionAuthorizer,
        enabledCampaignKeys: input.enabledCampaignKeys,
        getConfig: getCampaignAdminInstitutionThreadsRouteConfig,
        getPermissionName(config) {
          return config.permissionName;
        },
        buildAccessContext({ userId: accessUserId, config }) {
          return {
            userId: accessUserId,
            config,
          };
        },
        notFoundMessage: 'Campaign institution threads admin not found',
        forbiddenMessage:
          'You do not have permission to access this campaign institution threads admin',
      });
    },
  });
}

function encodeCursor(cursor: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function decodeCursor(encodedCursor: string): { updatedAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(encodedCursor, 'base64url').toString('utf-8');
    const parsed = deserialize(decoded);
    if (!parsed.ok) {
      return null;
    }

    return Value.Check(CampaignAdminInstitutionThreadCursorSchema, parsed.value)
      ? parsed.value
      : null;
  } catch {
    return null;
  }
}

function normalizeQueryValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue === '' ? undefined : trimmedValue;
}

function parseOptionalDateTime(value: string | undefined): Date | undefined {
  return value !== undefined ? new Date(value) : undefined;
}

function getUnknownQueryKeys(request: FastifyRequest): readonly string[] {
  const requestUrl = request.raw.url;
  if (requestUrl === undefined) {
    return [];
  }

  const searchParams = new URL(requestUrl, 'http://localhost').searchParams;
  const unknownKeys = new Set<string>();

  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      unknownKeys.add(key);
    }
  }

  return [...unknownKeys];
}

function areStateFiltersContradictory(input: {
  stateGroup?: CampaignAdminThreadStateGroup;
  threadState?: CampaignAdminInstitutionThreadsListQuery['threadState'];
}): boolean {
  if (input.stateGroup === undefined || input.threadState === undefined) {
    return false;
  }

  if (input.stateGroup === 'open') {
    return input.threadState === 'resolved';
  }

  return input.threadState !== 'resolved';
}

async function loadEntityNameMapForEntityCuis(input: {
  entityCuis: readonly string[];
  entityRepo: EntityRepository;
  log: Pick<FastifyBaseLogger, 'warn'>;
  failureMessage: string;
}): Promise<Map<string, string | null>> {
  if (input.entityCuis.length === 0) {
    return new Map();
  }

  const entitiesResult = await input.entityRepo.getByIds([...input.entityCuis]);
  if (entitiesResult.isErr()) {
    input.log.warn(
      { error: entitiesResult.error, entityCuis: input.entityCuis },
      input.failureMessage
    );
    return new Map();
  }

  return new Map(
    input.entityCuis.map((entityCui) => [
      entityCui,
      normalizeOptionalString(entitiesResult.value.get(entityCui)?.name ?? null),
    ])
  );
}

function getRetryableFlag(error: InstitutionCorrespondenceError): boolean {
  return 'retryable' in error ? error.retryable : false;
}

export interface MakeCampaignAdminInstitutionThreadRoutesDeps {
  repo: InstitutionCorrespondenceRepository;
  entityRepo: EntityRepository;
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: readonly string[];
}

export const makeCampaignAdminInstitutionThreadRoutes = (
  deps: MakeCampaignAdminInstitutionThreadRoutesDeps
): FastifyPluginAsync => {
  if (typeof deps.permissionAuthorizer.hasPermission !== 'function') {
    throw new Error('Campaign admin institution thread routes require a permission authorizer.');
  }

  if (deps.enabledCampaignKeys.length === 0) {
    throw new Error(
      'Campaign admin institution thread routes require at least one enabled campaign key.'
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync uses async plugin factories
  return async (fastify) => {
    const enabledCampaignKeys = new Set<string>(deps.enabledCampaignKeys);

    fastify.decorateRequest('campaignAdminInstitutionThreadsAccess', null);
    fastify.addHook(
      'preHandler',
      makeCampaignAdminInstitutionThreadsAuthHook({
        permissionAuthorizer: deps.permissionAuthorizer,
        enabledCampaignKeys,
      })
    );

    fastify.get<{
      Params: CampaignKeyParams;
      Querystring: CampaignAdminInstitutionThreadsListQuery;
    }>(
      '/api/v1/admin/campaigns/:campaignKey/institution-threads',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          querystring: CampaignAdminInstitutionThreadsListQuerySchema,
          response: {
            200: CampaignAdminInstitutionThreadsListResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminInstitutionThreadsAccess(request);
        const unknownQueryKeys = getUnknownQueryKeys(request);
        if (unknownQueryKeys.length > 0) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: `Unknown institution thread filters: ${unknownQueryKeys.join(', ')}`,
            retryable: false,
          });
        }

        if (
          areStateFiltersContradictory({
            ...(request.query.stateGroup !== undefined
              ? { stateGroup: request.query.stateGroup }
              : {}),
            ...(request.query.threadState !== undefined
              ? { threadState: request.query.threadState }
              : {}),
          })
        ) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'stateGroup and threadState cannot contradict each other.',
            retryable: false,
          });
        }

        const cursor =
          request.query.cursor !== undefined ? decodeCursor(request.query.cursor) : undefined;
        if (request.query.cursor !== undefined && cursor === null) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid institution thread cursor',
            retryable: false,
          });
        }

        const normalizedQuery = normalizeQueryValue(request.query.query);
        const normalizedEntityCui = normalizeQueryValue(request.query.entityCui);
        const updatedAtFrom = parseOptionalDateTime(request.query.updatedAtFrom);
        const updatedAtTo = parseOptionalDateTime(request.query.updatedAtTo);
        const latestResponseAtFrom = parseOptionalDateTime(request.query.latestResponseAtFrom);
        const latestResponseAtTo = parseOptionalDateTime(request.query.latestResponseAtTo);
        const listInput = {
          campaignKey: access.config.campaignKey,
          ...(request.query.stateGroup !== undefined
            ? { stateGroup: request.query.stateGroup }
            : {}),
          ...(request.query.threadState !== undefined
            ? { threadState: request.query.threadState }
            : {}),
          ...(request.query.responseStatus !== undefined
            ? { responseStatus: request.query.responseStatus }
            : {}),
          ...(normalizedQuery !== undefined ? { query: normalizedQuery } : {}),
          ...(normalizedEntityCui !== undefined ? { entityCui: normalizedEntityCui } : {}),
          ...(updatedAtFrom !== undefined ? { updatedAtFrom } : {}),
          ...(updatedAtTo !== undefined ? { updatedAtTo } : {}),
          ...(latestResponseAtFrom !== undefined ? { latestResponseAtFrom } : {}),
          ...(latestResponseAtTo !== undefined ? { latestResponseAtTo } : {}),
          ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
          limit: request.query.limit ?? DEFAULT_LIST_LIMIT,
        };

        const result = await listCampaignAdminThreads(
          {
            repo: deps.repo,
          },
          listInput
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: getRetryableFlag(result.error),
          });
        }

        const entityNameMap = await loadEntityNameMapForEntityCuis({
          entityCuis: [...new Set(result.value.items.map((thread) => thread.entityCui))],
          entityRepo: deps.entityRepo,
          log: fastify.log,
          failureMessage: 'Failed to load entity names for campaign-admin institution thread list',
        });

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value.items.map((thread) =>
              formatCampaignAdminThreadListItem({
                thread,
                entityName: entityNameMap.get(thread.entityCui) ?? null,
              })
            ),
            page: {
              limit: result.value.limit,
              totalCount: result.value.totalCount,
              hasMore: result.value.hasMore,
              nextCursor:
                result.value.nextCursor !== null ? encodeCursor(result.value.nextCursor) : null,
              sortBy: 'updatedAt',
              sortOrder: 'desc',
            },
          },
        });
      }
    );

    fastify.get<{ Params: CampaignAdminInstitutionThreadParams }>(
      '/api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId',
      {
        schema: {
          params: CampaignAdminInstitutionThreadParamsSchema,
          response: {
            200: CampaignAdminInstitutionThreadDetailResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminInstitutionThreadsAccess(request);
        const result = await getCampaignAdminThread(
          {
            repo: deps.repo,
          },
          {
            campaignKey: access.config.campaignKey,
            threadId: request.params.threadId,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: getRetryableFlag(result.error),
          });
        }

        const entityNameMap = await loadEntityNameMapForEntityCuis({
          entityCuis: [result.value.entityCui],
          entityRepo: deps.entityRepo,
          log: fastify.log,
          failureMessage: 'Failed to load entity name for campaign-admin institution thread detail',
        });

        return reply.status(200).send({
          ok: true,
          data: formatCampaignAdminThreadDetail({
            thread: result.value,
            entityName: entityNameMap.get(result.value.entityCui) ?? null,
          }),
        });
      }
    );

    fastify.post<{
      Params: CampaignAdminInstitutionThreadParams;
      Body: CampaignAdminInstitutionThreadResponseBody;
    }>(
      '/api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId/responses',
      {
        schema: {
          params: CampaignAdminInstitutionThreadParamsSchema,
          body: CampaignAdminInstitutionThreadResponseBodySchema,
          response: {
            200: CampaignAdminInstitutionThreadResponseCreateResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminInstitutionThreadsAccess(request);
        const result = await appendCampaignAdminThreadResponse(
          {
            repo: deps.repo,
          },
          {
            campaignKey: access.config.campaignKey,
            threadId: request.params.threadId,
            actorUserId: access.userId,
            expectedUpdatedAt: new Date(request.body.expectedUpdatedAt),
            responseDate: new Date(request.body.responseDate),
            messageContent: request.body.messageContent,
            responseStatus: request.body.responseStatus,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: getRetryableFlag(result.error),
          });
        }

        const entityNameMap = await loadEntityNameMapForEntityCuis({
          entityCuis: [result.value.thread.entityCui],
          entityRepo: deps.entityRepo,
          log: fastify.log,
          failureMessage:
            'Failed to load entity name for campaign-admin institution thread response',
        });

        return reply.status(200).send({
          ok: true,
          data: {
            ...formatCampaignAdminThreadDetail({
              thread: result.value.thread,
              entityName: entityNameMap.get(result.value.thread.entityCui) ?? null,
            }),
            createdResponseEventId: result.value.createdResponseEventId,
          },
        });
      }
    );
  };
};
