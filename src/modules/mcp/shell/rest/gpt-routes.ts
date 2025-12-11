/**
 * GPT REST API Routes
 *
 * REST endpoints for Custom GPT integration.
 * Calls existing MCP core use cases - same logic as MCP tools.
 * Wraps responses in {ok: true, data: ...} format.
 */

import { makeGptAuthHook, type GptAuthConfig } from './gpt-auth.js';
import {
  AnalyzeEntityBudgetInputSchema,
  BudgetBreakdownResponseSchema,
  DiscoverFiltersInputSchema,
  DiscoverFiltersResponseSchema,
  EntityBudgetResponseSchema,
  EntitySnapshotResponseSchema,
  ExploreBudgetBreakdownInputSchema,
  GetEntitySnapshotInputSchema,
  GptErrorResponseSchema,
  QueryTimeseriesInputSchema,
  RankEntitiesInputSchema,
  RankEntitiesResponseSchema,
  TimeseriesResponseSchema,
  type AnalyzeEntityBudgetInput,
  type DiscoverFiltersInput,
  type ExploreBudgetBreakdownInput,
  type GetEntitySnapshotInput,
  type QueryTimeseriesInput,
  type RankEntitiesInput,
} from './gpt-schemas.js';
import {
  analyzeEntityBudget,
  type AnalyzeEntityBudgetDeps,
} from '../../core/usecases/analyze-entity-budget.js';
import { discoverFilters, type DiscoverFiltersDeps } from '../../core/usecases/discover-filters.js';
import { exploreBudgetBreakdown } from '../../core/usecases/explore-budget-breakdown.js';
import {
  getEntitySnapshot,
  type GetEntitySnapshotDeps,
} from '../../core/usecases/get-entity-snapshot.js';
import { queryTimeseries, type QueryTimeseriesDeps } from '../../core/usecases/query-timeseries.js';
import { rankEntities, type RankEntitiesDeps } from '../../core/usecases/rank-entities.js';

import type { McpRateLimiter } from '../../core/ports.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies required for GPT routes.
 */
export interface MakeGptRoutesDeps {
  // Entity snapshot deps
  entityRepo: GetEntitySnapshotDeps['entityRepo'];
  executionRepo: GetEntitySnapshotDeps['executionRepo'];

  // Discover filters deps
  uatRepo: DiscoverFiltersDeps['uatRepo'];
  functionalClassificationRepo: DiscoverFiltersDeps['functionalClassificationRepo'];
  economicClassificationRepo: DiscoverFiltersDeps['economicClassificationRepo'];

  // Rank entities deps
  entityAnalyticsRepo: RankEntitiesDeps['entityAnalyticsRepo'];

  // Query timeseries deps
  analyticsService: QueryTimeseriesDeps['analyticsService'];

  // Analyze entity budget deps
  aggregatedLineItemsRepo: AnalyzeEntityBudgetDeps['aggregatedLineItemsRepo'];

  // Shared
  shareLink: {
    create(url: string): Promise<Result<string, unknown>>;
  };
  config: {
    clientBaseUrl: string;
  };
}

/**
 * Options for creating GPT routes.
 */
export interface GptRoutesOptions {
  deps: MakeGptRoutesDeps;
  auth: GptAuthConfig;
  rateLimiter?: McpRateLimiter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps error code to HTTP status.
 */
function getHttpStatus(errorCode: string): number {
  switch (errorCode) {
    case 'ENTITY_NOT_FOUND':
    case 'UAT_NOT_FOUND':
    case 'CLASSIFICATION_NOT_FOUND':
      return 404;
    case 'INVALID_INPUT':
    case 'INVALID_PERIOD':
    case 'INVALID_FILTER':
    case 'INVALID_CATEGORY':
      return 400;
    case 'RATE_LIMIT_EXCEEDED':
      return 429;
    case 'UNAUTHORIZED':
      return 401;
    default:
      return 500;
  }
}

/**
 * Sends an error response.
 */
function sendError(reply: FastifyReply, code: string, message: string): void {
  const status = getHttpStatus(code);
  void reply.status(status).send({
    ok: false,
    error: code,
    message,
  });
}

/**
 * Extracts data from MCP output (removes 'ok' field).
 */
function extractData<T extends { ok: boolean }>(output: T): Omit<T, 'ok'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- okField must be destructured to exclude it from spread
  const { ok: okField, ...data } = output;
  return data;
}

/**
 * Rate limit check helper.
 * @returns true if request is allowed, false if rate limited (response already sent)
 */
async function checkRateLimit(
  rateLimiter: McpRateLimiter | undefined,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  if (rateLimiter === undefined) {
    return true;
  }

  const key = request.ip;
  const allowed = await rateLimiter.isAllowed(key);

  if (!allowed) {
    sendError(reply, 'RATE_LIMIT_EXCEEDED', 'Too many requests');
    return false;
  }

  await rateLimiter.recordRequest(key);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates GPT REST API routes.
 */
export const makeGptRoutes = (options: GptRoutesOptions): FastifyPluginAsync => {
  const { deps, auth, rateLimiter } = options;
  const authHook = makeGptAuthHook(auth);

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync requires async signature
  return async (fastify) => {
    // Apply auth to all routes in this plugin
    fastify.addHook('preHandler', authHook);

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/gpt/entity-snapshot
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: GetEntitySnapshotInput }>(
      '/api/v1/gpt/entity-snapshot',
      {
        schema: {
          operationId: 'getEntitySnapshot',
          description: 'Get a point-in-time financial overview for a single public entity',
          tags: ['Budget Analytics'],
          body: GetEntitySnapshotInputSchema,
          response: {
            200: EntitySnapshotResponseSchema,
            400: GptErrorResponseSchema,
            401: GptErrorResponseSchema,
            404: GptErrorResponseSchema,
            429: GptErrorResponseSchema,
            500: GptErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!(await checkRateLimit(rateLimiter, request, reply))) return;

        const result = await getEntitySnapshot(
          {
            entityRepo: deps.entityRepo,
            executionRepo: deps.executionRepo,
            shareLink: deps.shareLink,
            config: deps.config,
          },
          request.body
        );

        if (result.isErr()) {
          sendError(reply, result.error.code, result.error.message);
          return;
        }

        return reply.status(200).send({
          ok: true,
          data: extractData(result.value),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/gpt/discover-filters
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: DiscoverFiltersInput }>(
      '/api/v1/gpt/discover-filters',
      {
        schema: {
          operationId: 'discoverFilters',
          description:
            'Resolve Romanian names/terms to machine-usable filter values (CUI, UAT ID, classification codes)',
          tags: ['Budget Analytics'],
          body: DiscoverFiltersInputSchema,
          response: {
            200: DiscoverFiltersResponseSchema,
            400: GptErrorResponseSchema,
            401: GptErrorResponseSchema,
            429: GptErrorResponseSchema,
            500: GptErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!(await checkRateLimit(rateLimiter, request, reply))) return;

        const result = await discoverFilters(
          {
            entityRepo: deps.entityRepo,
            uatRepo: deps.uatRepo,
            functionalClassificationRepo: deps.functionalClassificationRepo,
            economicClassificationRepo: deps.economicClassificationRepo,
          },
          request.body
        );

        if (result.isErr()) {
          sendError(reply, result.error.code, result.error.message);
          return;
        }

        return reply.status(200).send({
          ok: true,
          data: extractData(result.value),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/gpt/timeseries
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: QueryTimeseriesInput }>(
      '/api/v1/gpt/timeseries',
      {
        schema: {
          operationId: 'queryTimeseries',
          description: 'Query multi-series time-series data for comparison and trend analysis',
          tags: ['Budget Analytics'],
          body: QueryTimeseriesInputSchema,
          response: {
            200: TimeseriesResponseSchema,
            400: GptErrorResponseSchema,
            401: GptErrorResponseSchema,
            429: GptErrorResponseSchema,
            500: GptErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!(await checkRateLimit(rateLimiter, request, reply))) return;

        // Debug: Log incoming request
        request.log.debug(
          { operation: 'queryTimeseries', input: request.body },
          'GPT API: queryTimeseries called'
        );

        const result = await queryTimeseries(
          {
            analyticsService: deps.analyticsService,
            shareLink: deps.shareLink,
            config: deps.config,
          },
          request.body
        );

        if (result.isErr()) {
          // Debug: Log detailed error
          request.log.error(
            {
              operation: 'queryTimeseries',
              errorCode: result.error.code,
              errorMessage: result.error.message,
              input: request.body,
            },
            'GPT API: queryTimeseries failed'
          );
          sendError(reply, result.error.code, result.error.message);
          return;
        }

        request.log.debug(
          { operation: 'queryTimeseries', seriesCount: result.value.dataSeries.length },
          'GPT API: queryTimeseries succeeded'
        );

        return reply.status(200).send({
          ok: true,
          data: extractData(result.value),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/gpt/entity-budget
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: AnalyzeEntityBudgetInput }>(
      '/api/v1/gpt/entity-budget',
      {
        schema: {
          operationId: 'analyzeEntityBudget',
          description:
            'Analyze a single entity budget with breakdown by functional or economic classification',
          tags: ['Budget Analytics'],
          body: AnalyzeEntityBudgetInputSchema,
          response: {
            200: EntityBudgetResponseSchema,
            400: GptErrorResponseSchema,
            401: GptErrorResponseSchema,
            404: GptErrorResponseSchema,
            429: GptErrorResponseSchema,
            500: GptErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!(await checkRateLimit(rateLimiter, request, reply))) return;

        const result = await analyzeEntityBudget(
          {
            entityRepo: deps.entityRepo,
            aggregatedLineItemsRepo: deps.aggregatedLineItemsRepo,
            shareLink: deps.shareLink,
            config: deps.config,
          },
          request.body
        );

        if (result.isErr()) {
          sendError(reply, result.error.code, result.error.message);
          return;
        }

        return reply.status(200).send({
          ok: true,
          data: extractData(result.value),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/gpt/budget-breakdown
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: ExploreBudgetBreakdownInput }>(
      '/api/v1/gpt/budget-breakdown',
      {
        schema: {
          operationId: 'exploreBudgetBreakdown',
          description:
            'Explore budget hierarchically with progressive drill-down by classification',
          tags: ['Budget Analytics'],
          body: ExploreBudgetBreakdownInputSchema,
          response: {
            200: BudgetBreakdownResponseSchema,
            400: GptErrorResponseSchema,
            401: GptErrorResponseSchema,
            429: GptErrorResponseSchema,
            500: GptErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!(await checkRateLimit(rateLimiter, request, reply))) return;

        // Debug: Log incoming request
        request.log.debug(
          { operation: 'exploreBudgetBreakdown', input: request.body },
          'GPT API: exploreBudgetBreakdown called'
        );

        const result = await exploreBudgetBreakdown(
          {
            aggregatedLineItemsRepo: deps.aggregatedLineItemsRepo,
            shareLink: deps.shareLink,
            config: deps.config,
          },
          request.body
        );

        if (result.isErr()) {
          // Debug: Log detailed error
          request.log.error(
            {
              operation: 'exploreBudgetBreakdown',
              errorCode: result.error.code,
              errorMessage: result.error.message,
              input: request.body,
            },
            'GPT API: exploreBudgetBreakdown failed'
          );
          sendError(reply, result.error.code, result.error.message);
          return;
        }

        request.log.debug(
          {
            operation: 'exploreBudgetBreakdown',
            expenseGroups: result.value.item.expenseGroups?.length ?? 0,
            incomeGroups: result.value.item.incomeGroups?.length ?? 0,
          },
          'GPT API: exploreBudgetBreakdown succeeded'
        );

        return reply.status(200).send({
          ok: true,
          data: extractData(result.value),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/gpt/rank-entities
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: RankEntitiesInput }>(
      '/api/v1/gpt/rank-entities',
      {
        schema: {
          operationId: 'rankEntities',
          description: 'Rank entities by budget metrics with filtering, sorting, and pagination',
          tags: ['Budget Analytics'],
          body: RankEntitiesInputSchema,
          response: {
            200: RankEntitiesResponseSchema,
            400: GptErrorResponseSchema,
            401: GptErrorResponseSchema,
            429: GptErrorResponseSchema,
            500: GptErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!(await checkRateLimit(rateLimiter, request, reply))) return;

        // Debug: Log incoming request
        request.log.debug(
          { operation: 'rankEntities', input: request.body },
          'GPT API: rankEntities called'
        );

        const result = await rankEntities(
          {
            entityAnalyticsRepo: deps.entityAnalyticsRepo,
            shareLink: deps.shareLink,
            config: deps.config,
          },
          request.body
        );

        if (result.isErr()) {
          // Debug: Log detailed error
          request.log.error(
            {
              operation: 'rankEntities',
              errorCode: result.error.code,
              errorMessage: result.error.message,
              input: request.body,
            },
            'GPT API: rankEntities failed'
          );
          sendError(reply, result.error.code, result.error.message);
          return;
        }

        request.log.debug(
          {
            operation: 'rankEntities',
            entityCount: result.value.entities.length,
            totalCount: result.value.pageInfo.totalCount,
          },
          'GPT API: rankEntities succeeded'
        );

        return reply.status(200).send({
          ok: true,
          data: extractData(result.value),
        });
      }
    );
  };
};
