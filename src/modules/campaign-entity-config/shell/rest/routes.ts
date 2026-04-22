import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { FUNKY_CAMPAIGN_ADMIN_PERMISSION, FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import { deserialize } from '@/infra/cache/serialization.js';
import {
  makeCampaignAdminAuthorizationHook,
  resolveCampaignAdminPermissionAccess,
  type CampaignAdminPermissionAuthorizer,
} from '@/modules/campaign-admin/index.js';
import {
  CSV_UTF8_BOM,
  buildCsvAttachmentFilename,
  setCsvDownloadHeaders,
  toCsvRow,
  writeToResponseStream,
} from '@/modules/campaign-admin/shell/rest/csv.js';

import {
  CampaignEntityConfigCursorSchema,
  CampaignEntityConfigExportQuerySchema,
  CampaignEntityConfigListResponseSchema,
  CampaignEntityConfigListQuerySchema,
  CampaignEntityConfigParamsSchema,
  CampaignEntityConfigPutBodySchema,
  CampaignEntityConfigResponseSchema,
  CampaignKeyParamsSchema,
  ErrorResponseSchema,
  type CampaignEntityConfigExportQuery,
  type CampaignEntityConfigListQuery,
  type CampaignEntityConfigParams,
  type CampaignEntityConfigPutBody,
  type CampaignKeyParams,
} from './schemas.js';
import {
  createValidationError,
  getHttpStatusForError,
  type CampaignEntityConfigError,
} from '../../core/errors.js';
import { getCampaignEntityConfig } from '../../core/usecases/get-campaign-entity-config.js';
import { listCampaignEntityConfigs } from '../../core/usecases/list-campaign-entity-configs.js';
import {
  matchesCampaignEntityConfigQuery,
  normalizeEntityCui,
  normalizeOptionalQuery,
  validateUpdatedAtRange,
} from '../../core/usecases/shared.js';
import { upsertCampaignEntityConfig } from '../../core/usecases/upsert-campaign-entity-config.js';

import type {
  CampaignEntityConfigCampaignKey,
  CampaignEntityConfigListItem,
  CampaignEntityConfigListCursor,
  CampaignEntityConfigSortBy,
  CampaignEntityConfigSortOrder,
  CampaignEntityConfigValues,
} from '../../core/types.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { LearningProgressRepository } from '@/modules/learning-progress/index.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

const DEFAULT_LIST_LIMIT = 50;
const isOmittedPublicDebatePutCompatEnabled = (): boolean => true;
const ALLOWED_LIST_QUERY_KEYS = new Set<string>([
  'query',
  'entityCui',
  'budgetPublicationDate',
  'hasBudgetPublicationDate',
  'officialBudgetUrl',
  'hasOfficialBudgetUrl',
  'hasPublicDebate',
  'updatedAtFrom',
  'updatedAtTo',
  'sortBy',
  'sortOrder',
  'cursor',
  'limit',
]);
const ALLOWED_EXPORT_QUERY_KEYS = new Set<string>([
  'query',
  'entityCui',
  'budgetPublicationDate',
  'hasBudgetPublicationDate',
  'officialBudgetUrl',
  'hasOfficialBudgetUrl',
  'hasPublicDebate',
  'updatedAtFrom',
  'updatedAtTo',
  'sortBy',
  'sortOrder',
]);
const CAMPAIGN_ENTITY_CONFIG_EXPORT_HEADERS = [
  'Campaign Key',
  'Entity CUI',
  'Entity Name',
  'Users',
  'Configured',
  'budgetPublicationDate',
  'officialBudgetUrl',
  'public_debate.date',
  'public_debate.time',
  'public_debate.location',
  'public_debate.online_participation_link',
  'public_debate.announcement_link',
  'public_debate.description',
  'Updated At',
  'Updated By User ID',
] as const;

type CampaignEntityConfigSortKey = NonNullable<CampaignEntityConfigListQuery['sortBy']>;
type CampaignEntityConfigSortDirection = NonNullable<CampaignEntityConfigListQuery['sortOrder']>;

interface CampaignEntityConfigRouteConfig {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly permissionName: string;
}

interface CampaignEntityConfigAccessContext {
  readonly userId: string;
  readonly config: CampaignEntityConfigRouteConfig;
}

interface CampaignEntityConfigNormalizedSort {
  readonly sortBy: CampaignEntityConfigSortBy;
  readonly sortOrder: CampaignEntityConfigSortOrder;
}

interface CampaignEntityConfigExportItem {
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly config: CampaignEntityConfigListItem;
}

declare module 'fastify' {
  interface FastifyRequest {
    campaignEntityConfigAccess: CampaignEntityConfigAccessContext | null;
  }
}

const CAMPAIGN_ENTITY_CONFIG_ROUTE_CONFIGS: Readonly<
  Record<CampaignEntityConfigCampaignKey, CampaignEntityConfigRouteConfig>
> = {
  [FUNKY_CAMPAIGN_KEY]: {
    campaignKey: FUNKY_CAMPAIGN_KEY,
    permissionName: FUNKY_CAMPAIGN_ADMIN_PERMISSION,
  },
};

function getCampaignEntityConfigRouteConfig(
  campaignKey: string
): CampaignEntityConfigRouteConfig | null {
  if (campaignKey === FUNKY_CAMPAIGN_KEY) {
    return CAMPAIGN_ENTITY_CONFIG_ROUTE_CONFIGS[FUNKY_CAMPAIGN_KEY];
  }

  return null;
}

function getCampaignEntityConfigAccess(request: FastifyRequest): CampaignEntityConfigAccessContext {
  const access = request.campaignEntityConfigAccess;
  if (access === null) {
    throw new Error('Campaign entity config access context missing from request');
  }

  return access;
}

function makeCampaignEntityConfigAuthHook(input: {
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: ReadonlySet<string>;
}) {
  return makeCampaignAdminAuthorizationHook<CampaignEntityConfigAccessContext>({
    setAccessContext(request, accessContext) {
      request.campaignEntityConfigAccess = accessContext;
    },
    authorize: async ({ campaignKey, userId }) => {
      return resolveCampaignAdminPermissionAccess({
        campaignKey,
        userId,
        permissionAuthorizer: input.permissionAuthorizer,
        enabledCampaignKeys: input.enabledCampaignKeys,
        getConfig: getCampaignEntityConfigRouteConfig,
        getPermissionName(config) {
          return config.permissionName;
        },
        buildAccessContext({ userId: accessUserId, config }) {
          return {
            userId: accessUserId,
            config,
          };
        },
        notFoundMessage: 'Campaign entity config admin not found',
        forbiddenMessage: 'You do not have permission to access this campaign entity config admin',
      });
    },
  });
}

function getUnknownQueryKeys(
  request: FastifyRequest,
  allowedQueryKeys: ReadonlySet<string>
): readonly string[] {
  const requestUrl = request.raw.url;
  if (requestUrl === undefined) {
    return [];
  }

  const searchParams = new URL(requestUrl, 'http://localhost').searchParams;
  const unknownKeys = new Set<string>();

  for (const key of searchParams.keys()) {
    if (!allowedQueryKeys.has(key)) {
      unknownKeys.add(key);
    }
  }

  return [...unknownKeys];
}

function getDefaultSortOrder(
  sortBy: CampaignEntityConfigSortKey
): CampaignEntityConfigSortDirection {
  return sortBy === 'entityCui' ? 'asc' : 'desc';
}

function normalizeRequestedSort(
  query: Pick<CampaignEntityConfigListQuery, 'sortBy' | 'sortOrder'>
): CampaignEntityConfigNormalizedSort {
  const sortBy = query.sortBy ?? 'updatedAt';

  return {
    sortBy,
    sortOrder: query.sortOrder ?? getDefaultSortOrder(sortBy),
  };
}

function encodeCursor(cursor: CampaignEntityConfigListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function decodeCursor(value: string): CampaignEntityConfigListCursor | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf-8');
    const parsed = deserialize(decoded);
    if (!parsed.ok) {
      return null;
    }

    return Value.Check(CampaignEntityConfigCursorSchema, parsed.value) ? parsed.value : null;
  } catch {
    return null;
  }
}

function sendError(reply: FastifyReply, error: CampaignEntityConfigError) {
  const statusCode = getHttpStatusForError(error);
  return reply.status(statusCode).send({
    ok: false,
    error: error.type,
    message: error.message,
    retryable: 'retryable' in error ? error.retryable : false,
  });
}

function toCampaignEntityConfigExportItem(
  config: CampaignEntityConfigListItem
): CampaignEntityConfigExportItem {
  return {
    entityCui: config.entityCui,
    entityName: config.entityName,
    config,
  };
}

function toCampaignEntityConfigExportRow(item: CampaignEntityConfigExportItem): string {
  const publicDebate = item.config.values.public_debate;

  return toCsvRow([
    item.config.campaignKey,
    item.entityCui,
    item.entityName,
    item.config.usersCount,
    item.config.isConfigured,
    item.config.values.budgetPublicationDate,
    item.config.values.officialBudgetUrl,
    publicDebate?.date ?? null,
    publicDebate?.time ?? null,
    publicDebate?.location ?? null,
    publicDebate?.online_participation_link ?? null,
    publicDebate?.announcement_link ?? null,
    publicDebate?.description ?? null,
    item.config.updatedAt,
    item.config.updatedByUserId,
  ]);
}

async function resolveCampaignEntityConfigPutValues(input: {
  learningProgressRepo: LearningProgressRepository;
  entityRepo: EntityRepository;
  campaignKey: CampaignEntityConfigCampaignKey;
  entityCui: string;
  body: CampaignEntityConfigPutBody;
}): Promise<Result<CampaignEntityConfigValues, CampaignEntityConfigError>> {
  if (Object.hasOwn(input.body.values, 'public_debate')) {
    return ok(input.body.values as CampaignEntityConfigValues);
  }

  if (!isOmittedPublicDebatePutCompatEnabled()) {
    return err(createValidationError('values.public_debate is required.'));
  }

  const existingConfigResult = await getCampaignEntityConfig(
    {
      learningProgressRepo: input.learningProgressRepo,
      entityRepo: input.entityRepo,
    },
    {
      campaignKey: input.campaignKey,
      entityCui: input.entityCui,
    }
  );
  if (existingConfigResult.isErr()) {
    return err(existingConfigResult.error);
  }

  return ok({
    budgetPublicationDate: input.body.values.budgetPublicationDate,
    officialBudgetUrl: input.body.values.officialBudgetUrl,
    public_debate: existingConfigResult.value.values.public_debate,
  });
}

export interface MakeCampaignEntityConfigRoutesDeps {
  readonly learningProgressRepo: LearningProgressRepository;
  readonly entityRepo: EntityRepository;
  readonly audienceReader?: unknown;
  readonly permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  readonly enabledCampaignKeys: readonly CampaignEntityConfigCampaignKey[];
}

export const makeCampaignEntityConfigRoutes = (
  deps: MakeCampaignEntityConfigRoutesDeps
): FastifyPluginAsync => {
  if (typeof deps.permissionAuthorizer.hasPermission !== 'function') {
    throw new Error('Campaign entity config routes require a permission authorizer.');
  }

  if (deps.enabledCampaignKeys.length === 0) {
    throw new Error('Campaign entity config routes require at least one enabled campaign key.');
  }

  return async (fastify) => {
    const enabledCampaignKeys = new Set<string>(deps.enabledCampaignKeys);
    fastify.decorateRequest('campaignEntityConfigAccess', null);
    fastify.addHook(
      'preHandler',
      makeCampaignEntityConfigAuthHook({
        permissionAuthorizer: deps.permissionAuthorizer,
        enabledCampaignKeys,
      })
    );

    fastify.get<{ Params: CampaignEntityConfigParams }>(
      '/api/v1/admin/campaigns/:campaignKey/entities/:entityCui/config',
      {
        schema: {
          params: CampaignEntityConfigParamsSchema,
          response: {
            200: CampaignEntityConfigResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignEntityConfigAccess(request);
        const result = await getCampaignEntityConfig(
          {
            learningProgressRepo: deps.learningProgressRepo,
            entityRepo: deps.entityRepo,
          },
          {
            campaignKey: access.config.campaignKey,
            entityCui: request.params.entityCui,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.put<{ Params: CampaignEntityConfigParams; Body: CampaignEntityConfigPutBody }>(
      '/api/v1/admin/campaigns/:campaignKey/entities/:entityCui/config',
      {
        schema: {
          params: CampaignEntityConfigParamsSchema,
          body: CampaignEntityConfigPutBodySchema,
          response: {
            200: CampaignEntityConfigResponseSchema,
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
        const access = getCampaignEntityConfigAccess(request);
        const valuesResult = await resolveCampaignEntityConfigPutValues({
          learningProgressRepo: deps.learningProgressRepo,
          entityRepo: deps.entityRepo,
          campaignKey: access.config.campaignKey,
          entityCui: request.params.entityCui,
          body: request.body,
        });
        if (valuesResult.isErr()) {
          return sendError(reply, valuesResult.error);
        }

        const result = await upsertCampaignEntityConfig(
          {
            learningProgressRepo: deps.learningProgressRepo,
            entityRepo: deps.entityRepo,
          },
          {
            campaignKey: access.config.campaignKey,
            entityCui: request.params.entityCui,
            values: valuesResult.value,
            expectedUpdatedAt: request.body.expectedUpdatedAt,
            actorUserId: access.userId,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams; Querystring: CampaignEntityConfigListQuery }>(
      '/api/v1/admin/campaigns/:campaignKey/entity-config',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          querystring: CampaignEntityConfigListQuerySchema,
          response: {
            200: CampaignEntityConfigListResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignEntityConfigAccess(request);
        const unknownQueryKeys = getUnknownQueryKeys(request, ALLOWED_LIST_QUERY_KEYS);
        if (unknownQueryKeys.length > 0) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: `Unknown campaign entity config filters: ${unknownQueryKeys.join(', ')}`,
            retryable: false,
          });
        }

        const requestedSort = normalizeRequestedSort(request.query);
        const decodedCursor =
          request.query.cursor !== undefined ? decodeCursor(request.query.cursor) : undefined;
        if (request.query.cursor !== undefined && decodedCursor === null) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid campaign entity config cursor',
            retryable: false,
          });
        }

        const result = await listCampaignEntityConfigs(
          {
            learningProgressRepo: deps.learningProgressRepo,
            entityRepo: deps.entityRepo,
          },
          {
            campaignKey: access.config.campaignKey,
            ...(request.query.query !== undefined ? { query: request.query.query } : {}),
            ...(request.query.entityCui !== undefined
              ? { entityCui: request.query.entityCui }
              : {}),
            ...(request.query.budgetPublicationDate !== undefined
              ? { budgetPublicationDate: request.query.budgetPublicationDate }
              : {}),
            ...(request.query.hasBudgetPublicationDate !== undefined
              ? { hasBudgetPublicationDate: request.query.hasBudgetPublicationDate }
              : {}),
            ...(request.query.officialBudgetUrl !== undefined
              ? { officialBudgetUrl: request.query.officialBudgetUrl }
              : {}),
            ...(request.query.hasOfficialBudgetUrl !== undefined
              ? { hasOfficialBudgetUrl: request.query.hasOfficialBudgetUrl }
              : {}),
            ...(request.query.hasPublicDebate !== undefined
              ? { hasPublicDebate: request.query.hasPublicDebate }
              : {}),
            ...(request.query.updatedAtFrom !== undefined
              ? { updatedAtFrom: request.query.updatedAtFrom }
              : {}),
            ...(request.query.updatedAtTo !== undefined
              ? { updatedAtTo: request.query.updatedAtTo }
              : {}),
            sortBy: requestedSort.sortBy,
            sortOrder: requestedSort.sortOrder,
            limit: request.query.limit ?? DEFAULT_LIST_LIMIT,
            ...(decodedCursor !== undefined && decodedCursor !== null
              ? { cursor: decodedCursor }
              : {}),
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value.items,
            page: {
              limit: request.query.limit ?? DEFAULT_LIST_LIMIT,
              totalCount: result.value.totalCount,
              hasMore: result.value.hasMore,
              nextCursor:
                result.value.nextCursor === null ? null : encodeCursor(result.value.nextCursor),
              sortBy: requestedSort.sortBy,
              sortOrder: requestedSort.sortOrder,
            },
          },
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams; Querystring: CampaignEntityConfigExportQuery }>(
      '/api/v1/admin/campaigns/:campaignKey/entity-config/export',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          querystring: CampaignEntityConfigExportQuerySchema,
          response: {
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignEntityConfigAccess(request);
        const unknownQueryKeys = getUnknownQueryKeys(request, ALLOWED_EXPORT_QUERY_KEYS);
        if (unknownQueryKeys.length > 0) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: `Unknown campaign entity config filters: ${unknownQueryKeys.join(', ')}`,
            retryable: false,
          });
        }

        const normalizedQuery = normalizeOptionalQuery(request.query.query);
        let entityCui: string | undefined;
        if (request.query.entityCui !== undefined) {
          const entityCuiResult = normalizeEntityCui(request.query.entityCui);
          if (entityCuiResult.isErr()) {
            return sendError(reply, entityCuiResult.error);
          }

          entityCui = entityCuiResult.value;
        }

        const updatedAtRangeResult = validateUpdatedAtRange({
          ...(request.query.updatedAtFrom !== undefined
            ? { updatedAtFrom: request.query.updatedAtFrom }
            : {}),
          ...(request.query.updatedAtTo !== undefined
            ? { updatedAtTo: request.query.updatedAtTo }
            : {}),
        });
        if (updatedAtRangeResult.isErr()) {
          return sendError(reply, updatedAtRangeResult.error);
        }
        const exportFilename = buildCsvAttachmentFilename(
          `${access.config.campaignKey}-campaign-entity-config-export`
        );

        const loadExportPage = async (cursor?: CampaignEntityConfigListCursor) => {
          return listCampaignEntityConfigs(
            {
              learningProgressRepo: deps.learningProgressRepo,
              entityRepo: deps.entityRepo,
            },
            {
              campaignKey: access.config.campaignKey,
              ...(entityCui !== undefined ? { entityCui } : {}),
              ...(request.query.budgetPublicationDate !== undefined
                ? { budgetPublicationDate: request.query.budgetPublicationDate }
                : {}),
              ...(request.query.hasBudgetPublicationDate !== undefined
                ? { hasBudgetPublicationDate: request.query.hasBudgetPublicationDate }
                : {}),
              ...(request.query.officialBudgetUrl !== undefined
                ? { officialBudgetUrl: request.query.officialBudgetUrl }
                : {}),
              ...(request.query.hasOfficialBudgetUrl !== undefined
                ? { hasOfficialBudgetUrl: request.query.hasOfficialBudgetUrl }
                : {}),
              ...(request.query.hasPublicDebate !== undefined
                ? { hasPublicDebate: request.query.hasPublicDebate }
                : {}),
              ...(request.query.updatedAtFrom !== undefined
                ? { updatedAtFrom: request.query.updatedAtFrom }
                : {}),
              ...(request.query.updatedAtTo !== undefined
                ? { updatedAtTo: request.query.updatedAtTo }
                : {}),
              sortBy: 'entityCui',
              sortOrder: 'asc',
              limit: 500,
              ...(cursor !== undefined ? { cursor } : {}),
            }
          );
        };

        const firstPageResult = await loadExportPage();
        if (firstPageResult.isErr()) {
          return sendError(reply, firstPageResult.error);
        }

        reply.hijack();
        setCsvDownloadHeaders({
          response: reply.raw,
          filename: exportFilename,
          origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
        });

        try {
          await writeToResponseStream(reply.raw, CSV_UTF8_BOM);
          await writeToResponseStream(
            reply.raw,
            `${toCsvRow(CAMPAIGN_ENTITY_CONFIG_EXPORT_HEADERS)}\n`
          );

          let currentPage = firstPageResult.value;

          for (;;) {
            for (const item of currentPage.items) {
              if (!matchesCampaignEntityConfigQuery({ item, query: normalizedQuery })) {
                continue;
              }

              await writeToResponseStream(
                reply.raw,
                `${toCampaignEntityConfigExportRow(toCampaignEntityConfigExportItem(item))}\n`
              );
            }

            if (!currentPage.hasMore || currentPage.nextCursor === null) {
              break;
            }

            const nextPageResult = await loadExportPage(currentPage.nextCursor);
            if (nextPageResult.isErr()) {
              throw new Error(nextPageResult.error.message);
            }

            currentPage = nextPageResult.value;
          }

          reply.raw.end();
        } catch (error) {
          request.log.error(
            { err: error, campaignKey: access.config.campaignKey },
            'Failed while streaming campaign entity config export'
          );
          reply.raw.destroy(error instanceof Error ? error : new Error('CSV stream failed'));
        }

        return reply;
      }
    );
  };
};
