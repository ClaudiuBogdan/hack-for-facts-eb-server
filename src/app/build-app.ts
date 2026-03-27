/**
 * Fastify application factory
 * Creates and configures the Fastify instance with all plugins and routes
 */

import swagger from '@fastify/swagger';
import fastifyLib, {
  type FastifyInstance,
  type FastifyServerOptions,
  type FastifyError,
} from 'fastify';

import {
  wrapCountyAnalyticsRepo,
  wrapUATAnalyticsRepo,
  wrapEntityAnalyticsRepo,
  wrapExecutionAnalyticsRepo,
  wrapAggregatedLineItemsRepo,
  wrapBudgetSectorRepo,
  wrapFundingSourceRepo,
  wrapFundingSourceLineItemRepo,
  wrapFunctionalClassificationRepo,
  wrapEconomicClassificationRepo,
  wrapPopulationRepo,
  wrapExecutionLineItemsRepo,
  wrapInsRepo,
} from './cache-wrappers.js';
import { makePublicDebateRequestSyncHook } from './public-debate-request-dispatcher.js';
import { makePublicDebateSelfSendContextLookup } from './public-debate-self-send-context-lookup.js';
import { initCache, createCacheConfig, type CacheClient } from '../infra/cache/index.js';
import {
  makeEmailClient,
  makeReceivedEmailFetcher,
  makeWebhookVerifier,
} from '../infra/email/client.js';
import {
  makeGraphQLPlugin,
  CommonGraphQLSchema,
  commonGraphQLResolvers,
} from '../infra/graphql/index.js';
import { BaseSchema } from '../infra/graphql/schema.js';
import { registerCors, registerSecurityHeaders } from '../infra/plugins/index.js';
import {
  makeAdvancedMapAnalyticsRepo,
  makeAdvancedMapAnalyticsRoutes,
  makeAdvancedMapAnalyticsGroupedSeriesRoutes,
  makeDbAdvancedMapAnalyticsGroupedSeriesProvider,
  defaultAdvancedMapAnalyticsIdGenerator,
} from '../modules/advanced-map-analytics/index.js';
import {
  makeAggregatedLineItemsResolvers,
  AggregatedLineItemsSchema,
  makeAggregatedLineItemsRepo,
  makePopulationRepo,
} from '../modules/aggregated-line-items/index.js';
import { makeGraphQLContext, ANONYMOUS_SESSION, type AuthProvider } from '../modules/auth/index.js';
import { makeAuthMiddleware } from '../modules/auth/shell/middleware/fastify-auth.js';
import {
  makeBudgetSectorResolvers,
  BudgetSectorSchema,
  makeBudgetSectorRepo,
  type BudgetSectorRepository,
} from '../modules/budget-sector/index.js';
import {
  makeClassificationResolvers,
  ClassificationSchema,
  makeFunctionalClassificationRepo,
  makeEconomicClassificationRepo,
} from '../modules/classification/index.js';
import {
  CommitmentsSchema,
  makeCommitmentsRepo,
  makeCommitmentsResolvers,
} from '../modules/commitments/index.js';
import {
  makeCountyAnalyticsResolvers,
  CountyAnalyticsSchema,
  makeCountyAnalyticsRepo,
} from '../modules/county-analytics/index.js';
import {
  type DatasetRepo,
  DatasetsSchema,
  makeDatasetsResolvers,
} from '../modules/datasets/index.js';
import {
  makeEntityResolvers,
  EntitySchema,
  makeEntityRepo,
  makeEntityProfileRepo,
  makeEntityAnalyticsSummaryRepo,
  createEntityLoaders,
} from '../modules/entity/index.js';
import {
  makeEntityAnalyticsResolvers,
  EntityAnalyticsSchema,
  makeEntityAnalyticsRepo,
} from '../modules/entity-analytics/index.js';
import {
  makeExecutionAnalyticsResolvers,
  ExecutionAnalyticsSchema,
  makeAnalyticsRepo,
} from '../modules/execution-analytics/index.js';
import {
  makeExecutionLineItemResolvers,
  ExecutionLineItemSchema,
  makeExecutionLineItemRepo as makeExecutionLineItemsModuleRepo,
  createExecutionLineItemLoaders,
  type ExecutionLineItemRepository as ExecutionLineItemsModuleRepository,
} from '../modules/execution-line-items/index.js';
import {
  makeFundingSourceResolvers,
  FundingSourceSchema,
  makeFundingSourceRepo,
  makeExecutionLineItemRepo,
  type FundingSourceRepository,
  type ExecutionLineItemRepository,
} from '../modules/funding-sources/index.js';
import {
  makeHealthRoutes,
  makeHealthResolvers,
  healthSchema,
  makeDbHealthChecker,
  makeCacheHealthChecker,
  type HealthChecker,
} from '../modules/health/index.js';
import { InsSchema, makeInsRepo, makeInsResolvers } from '../modules/ins/index.js';
import {
  makeInstitutionCorrespondenceAdminRoutes,
  makeInstitutionCorrespondenceRoutes,
  makeInstitutionCorrespondenceRepo,
  makeInstitutionCorrespondenceResendSideEffect,
  makeOfficialEmailLookup,
  makePublicDebateTemplateRenderer,
  buildSharedCorrespondenceInboxAddress,
} from '../modules/institution-correspondence/index.js';
import {
  makeLearningProgressAdminReviewRoutes,
  makeLearningProgressRoutes,
  makeLearningProgressRepo,
} from '../modules/learning-progress/index.js';
import {
  createMcpServer,
  makeMcpRoutes,
  makeInMemorySessionStore,
  makeInMemoryRateLimiter,
  makeMcpExecutionRepo,
  makeMcpAnalyticsService,
  makeEntityAdapter,
  makeUatAdapter,
  makeFunctionalClassificationAdapter,
  makeEconomicClassificationAdapter,
  makeShareLinkAdapter,
  makeEntityAnalyticsAdapter,
  makeAggregatedLineItemsAdapter,
  DEFAULT_MCP_CONFIG,
  type McpConfig,
  // GPT REST API
  makeGptRoutes,
  gptOpenApiConfig,
  type GptRoutesOptions,
} from '../modules/mcp/index.js';
import { NormalizationService } from '../modules/normalization/index.js';
import {
  makeDeliveryRepo,
  makeResendWebhookDeliverySideEffect,
} from '../modules/notification-delivery/index.js';
import {
  makeNotificationRoutes,
  makeNotificationsRepo,
  makeDeliveriesRepo,
  makeTokensRepo,
  sha256Hasher,
} from '../modules/notifications/index.js';
import {
  makeReportResolvers,
  ReportSchema,
  makeReportRepo,
  createReportLoaders,
} from '../modules/report/index.js';
import {
  makeResendWebhookEmailEventsRepo,
  makeResendWebhookRoutes,
} from '../modules/resend-webhooks/index.js';
import {
  makeShareRoutes,
  makeShortLinkRepo,
  noopCache,
  cryptoHasher,
  type ShareConfig,
} from '../modules/share/index.js';
import {
  makeUATResolvers,
  UATSchema,
  makeUATRepo,
  createUATLoaders,
} from '../modules/uat/index.js';
import {
  makeUATAnalyticsResolvers,
  UATAnalyticsSchema,
  makeUATAnalyticsRepo,
} from '../modules/uat-analytics/index.js';

import type { AppConfig } from '../infra/config/env.js';
import type { BudgetDbClient, InsDbClient, UserDbClient } from '../infra/database/client.js';

/**
 * Application dependencies that can be injected
 */
export interface AppDeps {
  healthCheckers?: HealthChecker[];
  budgetDb: BudgetDbClient;
  insDb: InsDbClient;
  /** User database for notifications and other user-related data */
  userDb?: UserDbClient;
  datasetRepo: DatasetRepo;
  budgetSectorRepo?: BudgetSectorRepository;
  fundingSourceRepo?: FundingSourceRepository;
  /** Repository for funding source nested resolver (funding-sources module) */
  executionLineItemRepo?: ExecutionLineItemRepository;
  /** Repository for execution line items module (standalone queries) */
  executionLineItemsModuleRepo?: ExecutionLineItemsModuleRepository;
  config: AppConfig;
  /** Optional cache client for testing (auto-initialized if not provided) */
  cacheClient?: CacheClient;
  /**
   * Optional auth provider for token verification.
   * When provided, GraphQL context will include auth information.
   * Resolvers can use `requireAuthOrThrow` or `withAuth` to require authentication.
   */
  authProvider?: AuthProvider;
}

/**
 * Application options combining Fastify options with our custom deps
 */
export interface AppOptions {
  fastifyOptions?: FastifyServerOptions;
  deps?: Partial<AppDeps>; // Allow partial for tests/defaults, but runtime needs them
  version?: string | undefined;
}

const HEALTH_ROUTE_PATHS = new Set(['/health', '/health/live', '/health/ready']);
const LEARNING_PROGRESS_ADMIN_REVIEW_PATH = '/api/v1/admin/learning-progress/reviews';
const INSTITUTION_CORRESPONDENCE_ADMIN_ROUTE_PREFIX = '/api/v1/admin/institution-correspondence';
const GPT_ROUTE_PREFIX = '/api/v1/gpt/';
const WEBHOOK_RESEND_ROUTE_PATH = '/api/v1/webhooks/resend';
const NOTIFICATIONS_UNSUBSCRIBE_ROUTE_PREFIX = '/api/v1/notifications/unsubscribe/';
const SHORT_LINK_RESOLVE_ROUTE_PREFIX = '/api/v1/short-links/';
const ADVANCED_MAP_PUBLIC_ROUTE_PREFIX = '/api/v1/advanced-map-analytics/public/';
const ADVANCED_MAP_GROUPED_SERIES_ROUTE_PATH = '/api/v1/advanced-map-analytics/grouped-series';
const SAFE_ERROR_CODES = new Set([
  'ValidationError',
  'NotFoundError',
  'AuthenticationRequiredError',
  'ForbiddenError',
  'RateLimitExceededError',
  'BadRequestError',
  'ConflictError',
]);
const GENERIC_MESSAGES: Record<number, string> = {
  400: 'Invalid request',
  401: 'Authentication required',
  403: 'Access denied',
  404: 'Resource not found',
  409: 'Conflict with current state',
  422: 'Unprocessable request',
  429: 'Too many requests',
};

function getRequestPath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function isHealthRoute(url: string): boolean {
  return HEALTH_ROUTE_PATHS.has(getRequestPath(url));
}

function isLearningProgressAdminReviewRoute(url: string): boolean {
  return getRequestPath(url) === LEARNING_PROGRESS_ADMIN_REVIEW_PATH;
}

function isInstitutionCorrespondenceAdminRoute(url: string): boolean {
  return getRequestPath(url).startsWith(INSTITUTION_CORRESPONDENCE_ADMIN_ROUTE_PREFIX);
}

function shouldBypassGlobalAuthValidation(request: import('fastify').FastifyRequest): boolean {
  const path = getRequestPath(request.url);

  if (request.method === 'OPTIONS') {
    return true;
  }

  if (isHealthRoute(path)) {
    return true;
  }

  if (isLearningProgressAdminReviewRoute(path) || isInstitutionCorrespondenceAdminRoute(path)) {
    return true;
  }

  if (
    path === '/mcp' ||
    path === '/openapi.json' ||
    path === WEBHOOK_RESEND_ROUTE_PATH ||
    path === ADVANCED_MAP_GROUPED_SERIES_ROUTE_PATH ||
    path.startsWith(GPT_ROUTE_PREFIX) ||
    path.startsWith(NOTIFICATIONS_UNSUBSCRIBE_ROUTE_PREFIX) ||
    path.startsWith(ADVANCED_MAP_PUBLIC_ROUTE_PREFIX)
  ) {
    return true;
  }

  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    path.startsWith(SHORT_LINK_RESOLVE_ROUTE_PREFIX)
  ) {
    return true;
  }

  return false;
}

function getPublicErrorCode(error: FastifyError, statusCode: number): string {
  if (error.validation != null) {
    return 'ValidationError';
  }

  if (SAFE_ERROR_CODES.has(error.name)) {
    return error.name;
  }

  if (SAFE_ERROR_CODES.has(error.code)) {
    return error.code;
  }

  switch (statusCode) {
    case 400:
    case 422:
      return 'ValidationError';
    case 401:
      return 'AuthenticationRequiredError';
    case 403:
      return 'ForbiddenError';
    case 404:
      return 'NotFoundError';
    case 409:
      return 'ConflictError';
    case 429:
      return 'RateLimitExceededError';
    default:
      return statusCode >= 400 && statusCode < 500 ? 'BadRequestError' : 'InternalServerError';
  }
}

function getLogBindingUserId(request: import('fastify').FastifyRequest): string | undefined {
  const candidate = request.log as unknown as {
    bindings?: () => Record<string, unknown>;
  };

  if (typeof candidate.bindings !== 'function') {
    return undefined;
  }

  const userId = candidate.bindings()['userId'];
  return typeof userId === 'string' && userId.length > 0 ? userId : undefined;
}

function getRequestUserId(request: import('fastify').FastifyRequest): string | undefined {
  const authCandidate = request as unknown as {
    auth?: {
      userId?: unknown;
    };
  };

  const authUserId = authCandidate.auth?.userId;
  if (typeof authUserId === 'string' && authUserId.length > 0) {
    return authUserId;
  }

  return getLogBindingUserId(request);
}

/**
 * Creates and configures the Fastify application
 * This is the composition root where all modules are wired together
 */
export const buildApp = async (options: AppOptions = {}): Promise<FastifyInstance> => {
  const { fastifyOptions = {}, deps = {}, version } = options;

  if (
    deps.budgetDb === undefined ||
    deps.insDb === undefined ||
    deps.datasetRepo === undefined ||
    deps.config === undefined
  ) {
    throw new Error('Missing required dependencies: budgetDb, insDb, datasetRepo, config');
  }

  const budgetDb = deps.budgetDb;
  const insDb = deps.insDb;
  const datasetRepo = deps.datasetRepo;
  const config = deps.config;

  // Create Fastify instance
  const app = fastifyLib({
    ...fastifyOptions,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'Request error');

    const isProduction = config.server.isProduction;

    if (error.validation != null) {
      return reply.status(400).send({
        ok: false,
        error: 'ValidationError',
        message: 'Request validation failed',
        ...(isProduction ? {} : { details: error.validation }),
      });
    }

    if (error.statusCode != null) {
      const statusCode = error.statusCode;
      const isSafeError = SAFE_ERROR_CODES.has(error.name) || SAFE_ERROR_CODES.has(error.code);

      const message =
        isSafeError || statusCode < 500
          ? isProduction
            ? (GENERIC_MESSAGES[statusCode] ?? error.message)
            : error.message
          : isProduction
            ? 'An unexpected error occurred'
            : error.message;

      return reply.status(statusCode).send({
        ok: false,
        error: getPublicErrorCode(error, statusCode),
        message,
      });
    }

    return reply.status(500).send({
      ok: false,
      error: 'InternalServerError',
      message: isProduction ? 'An unexpected error occurred' : error.message,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      ok: false,
      error: 'NotFoundError',
      message: config.server.isProduction
        ? 'Not found'
        : `Route ${request.method} ${request.url} not found`,
    });
  });

  const requestStartTimes = new WeakMap<import('fastify').FastifyRequest, bigint>();

  // Emit a consistent completion log where userId is included if auth middleware enriched request.log.
  app.addHook('onRequest', (request, _reply, done) => {
    if (isHealthRoute(request.url)) {
      done();
      return;
    }

    requestStartTimes.set(request, process.hrtime.bigint());

    const userId = getRequestUserId(request);

    app.log.info(
      {
        reqId: request.id,
        req: {
          method: request.method,
          url: request.url,
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        },
        ...(userId !== undefined ? { userId } : {}),
      },
      'incoming request'
    );

    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (isHealthRoute(request.url)) {
      done();
      return;
    }

    const startedAt = requestStartTimes.get(request);
    const responseTime =
      startedAt !== undefined ? Number(process.hrtime.bigint() - startedAt) / 1_000_000 : undefined;

    const userId = getRequestUserId(request);

    app.log.info(
      {
        reqId: request.id,
        req: {
          method: request.method,
          url: request.url,
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        },
        res: { statusCode: reply.statusCode },
        ...(responseTime !== undefined ? { responseTime } : {}),
        ...(userId !== undefined ? { userId } : {}),
      },
      'request completed'
    );

    done();
  });

  // Register CORS plugin
  await registerCors(app, config);

  // Register security headers plugin (SEC-003)
  await registerSecurityHeaders(app, config);

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Cache Infrastructure
  // ─────────────────────────────────────────────────────────────────────────────
  const cacheConfig = createCacheConfig(process.env);
  const { cache, keyBuilder, rawCache } =
    deps.cacheClient ??
    initCache({ config: cacheConfig, logger: app.log as unknown as import('pino').Logger });

  // ─────────────────────────────────────────────────────────────────────────────
  // Create Health Checkers
  // ─────────────────────────────────────────────────────────────────────────────
  // Create checkers from actual infrastructure dependencies.
  // - Database checkers are critical (failure = 503 unhealthy)
  // - Cache checker is non-critical (failure = 200 degraded)
  const infrastructureCheckers: HealthChecker[] = [];

  // Budget database checker (always required)
  infrastructureCheckers.push(makeDbHealthChecker(budgetDb, { name: 'database' }));
  // INS database checker (always required)
  infrastructureCheckers.push(makeDbHealthChecker(insDb, { name: 'ins-database' }));

  // User database checker (when configured)
  if (deps.userDb !== undefined) {
    infrastructureCheckers.push(makeDbHealthChecker(deps.userDb, { name: 'user-database' }));
  }

  // Cache checker (non-critical)
  infrastructureCheckers.push(makeCacheHealthChecker(rawCache, { name: 'cache' }));

  // Combine infrastructure checkers with any custom checkers from deps
  const allHealthCheckers = [...infrastructureCheckers, ...(deps.healthCheckers ?? [])];

  // Register health routes
  // SECURITY: SEC-009 - Only expose version in non-production environments
  await app.register(
    makeHealthRoutes({
      ...(!config.server.isProduction && version !== undefined && { version }),
      checkers: allHealthCheckers,
    })
  );

  // Setup GraphQL
  // SECURITY: SEC-009 - Only expose version in non-production environments
  const healthResolvers = makeHealthResolvers({
    ...(!config.server.isProduction && version !== undefined && { version }),
    checkers: allHealthCheckers,
  });

  // Create shared population repo (used by both analytics and aggregated line items)
  const rawPopulationRepo = makePopulationRepo(budgetDb);
  const populationRepo = wrapPopulationRepo(rawPopulationRepo, cache, keyBuilder);

  // Setup Analytics Module
  const rawAnalyticsRepo = makeAnalyticsRepo(budgetDb);
  const analyticsRepo = wrapExecutionAnalyticsRepo(rawAnalyticsRepo, cache, keyBuilder);
  const analyticsResolvers = makeExecutionAnalyticsResolvers({
    analyticsRepo,
    datasetRepo,
    populationRepo,
  });

  // Setup Aggregated Line Items Module
  const normalizationService = await NormalizationService.create(datasetRepo);
  const rawAggregatedLineItemsRepo = makeAggregatedLineItemsRepo(budgetDb);
  const aggregatedLineItemsRepo = wrapAggregatedLineItemsRepo(
    rawAggregatedLineItemsRepo,
    cache,
    keyBuilder
  );
  const aggregatedLineItemsResolvers = makeAggregatedLineItemsResolvers({
    repo: aggregatedLineItemsRepo,
    normalization: normalizationService,
    populationRepo,
  });

  // Setup Commitments Module
  const commitmentsRepo = makeCommitmentsRepo(budgetDb);
  const commitmentsResolvers = makeCommitmentsResolvers({
    repo: commitmentsRepo,
    normalizationService,
    populationRepo,
  });

  // Setup Entity Analytics Module
  const rawEntityAnalyticsRepo = makeEntityAnalyticsRepo(budgetDb);
  const entityAnalyticsRepo = wrapEntityAnalyticsRepo(rawEntityAnalyticsRepo, cache, keyBuilder);
  const entityAnalyticsResolvers = makeEntityAnalyticsResolvers({
    repo: entityAnalyticsRepo,
    normalization: normalizationService,
  });

  // Setup Datasets Module (GraphQL interface for static datasets)
  const datasetsResolvers = makeDatasetsResolvers({
    datasetRepo,
  });

  // Setup Budget Sector Module
  const rawBudgetSectorRepo = deps.budgetSectorRepo ?? makeBudgetSectorRepo(budgetDb);
  const budgetSectorRepo = wrapBudgetSectorRepo(rawBudgetSectorRepo, cache, keyBuilder);
  const budgetSectorResolvers = makeBudgetSectorResolvers({
    budgetSectorRepo,
  });

  // Setup Funding Source Module
  const rawFundingSourceRepo = deps.fundingSourceRepo ?? makeFundingSourceRepo(budgetDb);
  const fundingSourceRepo = wrapFundingSourceRepo(rawFundingSourceRepo, cache, keyBuilder);
  const rawFundingSourceLineItemRepo =
    deps.executionLineItemRepo ?? makeExecutionLineItemRepo(budgetDb);
  const executionLineItemRepo = wrapFundingSourceLineItemRepo(
    rawFundingSourceLineItemRepo,
    cache,
    keyBuilder
  );
  const fundingSourceResolvers = makeFundingSourceResolvers({
    fundingSourceRepo,
    executionLineItemRepo,
  });

  // Setup Execution Line Items Module (standalone queries with DataLoaders)
  const rawExecutionLineItemsModuleRepo =
    deps.executionLineItemsModuleRepo ?? makeExecutionLineItemsModuleRepo(budgetDb);
  const executionLineItemsModuleRepo = wrapExecutionLineItemsRepo(
    rawExecutionLineItemsModuleRepo,
    cache,
    keyBuilder
  );
  const executionLineItemsResolvers = makeExecutionLineItemResolvers({
    executionLineItemRepo: executionLineItemsModuleRepo,
    normalizationService,
  });

  // Setup Entity Module
  const entityRepo = makeEntityRepo(budgetDb);
  const entityProfileRepo = makeEntityProfileRepo(budgetDb);
  const entityAnalyticsSummaryRepo = makeEntityAnalyticsSummaryRepo(budgetDb);
  const uatRepo = makeUATRepo(budgetDb);
  const reportRepo = makeReportRepo(budgetDb);
  const entityResolvers = makeEntityResolvers({
    entityRepo,
    uatRepo,
    reportRepo,
    executionLineItemRepo: executionLineItemsModuleRepo,
    entityAnalyticsSummaryRepo,
    normalizationService,
  });

  // Setup UAT Module (Query resolvers for UAT queries)
  const uatResolvers = makeUATResolvers({
    uatRepo,
  });

  // Setup Report Module (Query resolvers for Report queries)
  const reportResolvers = makeReportResolvers({
    reportRepo,
    executionLineItemRepo: executionLineItemsModuleRepo,
  });

  // Setup UAT Analytics Module
  const rawUatAnalyticsRepo = makeUATAnalyticsRepo(budgetDb);
  const uatAnalyticsRepo = wrapUATAnalyticsRepo(rawUatAnalyticsRepo, cache, keyBuilder);
  const uatAnalyticsResolvers = makeUATAnalyticsResolvers({
    repo: uatAnalyticsRepo,
    normalizationService,
  });

  // Setup County Analytics Module
  const rawCountyAnalyticsRepo = makeCountyAnalyticsRepo(budgetDb);
  const countyAnalyticsRepo = wrapCountyAnalyticsRepo(rawCountyAnalyticsRepo, cache, keyBuilder);
  const countyAnalyticsResolvers = makeCountyAnalyticsResolvers({
    repo: countyAnalyticsRepo,
    normalizationService,
    entityRepo,
  });

  // Setup Classification Module
  const rawFunctionalClassificationRepo = makeFunctionalClassificationRepo(budgetDb);
  const functionalClassificationRepo = wrapFunctionalClassificationRepo(
    rawFunctionalClassificationRepo,
    cache,
    keyBuilder
  );
  const rawEconomicClassificationRepo = makeEconomicClassificationRepo(budgetDb);
  const economicClassificationRepo = wrapEconomicClassificationRepo(
    rawEconomicClassificationRepo,
    cache,
    keyBuilder
  );
  const classificationResolvers = makeClassificationResolvers({
    functionalClassificationRepo,
    economicClassificationRepo,
  });

  // Setup INS Module
  const rawInsRepo = makeInsRepo(insDb);
  const insRepo = wrapInsRepo(rawInsRepo, cache, keyBuilder);
  const insResolvers = makeInsResolvers({ insRepo });

  // Combine schemas and resolvers
  const schema = [
    BaseSchema,
    CommonGraphQLSchema,
    healthSchema,
    ExecutionAnalyticsSchema,
    AggregatedLineItemsSchema,
    CommitmentsSchema,
    EntityAnalyticsSchema,
    DatasetsSchema,
    BudgetSectorSchema,
    FundingSourceSchema,
    ExecutionLineItemSchema,
    EntitySchema,
    UATSchema,
    ReportSchema,
    UATAnalyticsSchema,
    CountyAnalyticsSchema,
    ClassificationSchema,
    InsSchema,
  ];
  const resolvers = [
    commonGraphQLResolvers,
    healthResolvers,
    analyticsResolvers,
    aggregatedLineItemsResolvers,
    commitmentsResolvers,
    entityAnalyticsResolvers,
    datasetsResolvers,
    budgetSectorResolvers,
    fundingSourceResolvers,
    executionLineItemsResolvers,
    entityResolvers,
    uatResolvers,
    reportResolvers,
    uatAnalyticsResolvers,
    countyAnalyticsResolvers,
    classificationResolvers,
    insResolvers,
  ];

  // Create Mercurius loaders for N+1 prevention
  // Combine loaders from all modules
  const executionLineItemLoaders = createExecutionLineItemLoaders(budgetDb);
  const entityLoaders = createEntityLoaders({ db: budgetDb, entityProfileRepo });
  const uatLoaders = createUATLoaders(budgetDb);
  const reportLoaders = createReportLoaders(budgetDb);

  // Merge all loaders into a single object
  const combinedLoaders = {
    ...executionLineItemLoaders,
    ...entityLoaders,
    ...uatLoaders,
    ...reportLoaders,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Setup Authentication Context (Optional)
  // ─────────────────────────────────────────────────────────────────────────────
  // When an authProvider is injected, GraphQL context includes auth information.
  // Resolvers can use requireAuthOrThrow() or withAuth() to enforce authentication.
  const graphQLContext =
    deps.authProvider !== undefined
      ? makeGraphQLContext({ authProvider: deps.authProvider })
      : undefined;

  await app.register(
    makeGraphQLPlugin({
      schema,
      resolvers,
      loaders: combinedLoaders,
      isProduction: config.server.isProduction,
      ...(graphQLContext !== undefined && { context: graphQLContext }),
    })
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Setup Notifications Module (REST API)
  // ─────────────────────────────────────────────────────────────────────────────
  // Notifications requires userDb to be configured for repositories.
  // Auth middleware requires authProvider - if not configured, protected routes will fail.
  if (deps.userDb !== undefined) {
    const userDb = deps.userDb;

    // Add global auth middleware for REST routes
    if (deps.authProvider !== undefined) {
      // Full auth middleware with token verification
      const authMiddleware = makeAuthMiddleware({ authProvider: deps.authProvider });
      app.addHook('preHandler', async (request, reply) => {
        if (shouldBypassGlobalAuthValidation(request)) {
          request.auth = ANONYMOUS_SESSION;
          return;
        }

        await (authMiddleware as (req: typeof request, rep: typeof reply) => Promise<void>)(
          request,
          reply
        );
      });
    } else {
      // Fallback: set anonymous session when no auth provider configured
      // This allows routes to be registered but protected endpoints will return 401
      app.addHook('preHandler', (request, _reply, done) => {
        request.auth = ANONYMOUS_SESSION;
        done();
      });
    }

    // Create notification repositories
    const repoLogger = app.log as unknown as import('pino').Logger;
    const notificationsRepo = makeNotificationsRepo({ db: userDb, logger: repoLogger });
    const deliveriesRepo = makeDeliveriesRepo({ db: userDb, logger: repoLogger });
    const tokensRepo = makeTokensRepo({ db: userDb, logger: repoLogger });
    const emailEventsRepo =
      config.email.webhookSecret !== undefined
        ? makeResendWebhookEmailEventsRepo({
            db: userDb,
            logger: repoLogger,
          })
        : undefined;
    const resendWebhookSideEffects: {
      handle(input: {
        event: import('../modules/resend-webhooks/index.js').ResendEmailWebhookEvent;
        storedEvent: import('../modules/resend-webhooks/index.js').StoredResendEmailEvent;
      }): Promise<void>;
    }[] = [];
    let learningProgressOnSyncEventsApplied:
      | ((input: {
          userId: string;
          events: readonly import('../modules/learning-progress/index.js').LearningProgressEvent[];
        }) => Promise<void>)
      | undefined;

    // Register notification routes
    await app.register(
      makeNotificationRoutes({
        notificationsRepo,
        deliveriesRepo,
        tokensRepo,
        hasher: sha256Hasher,
      })
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Institution Correspondence Module (Admin REST API + Webhook Side Effects)
    // ─────────────────────────────────────────────────────────────────────────
    if (config.email.enabled) {
      const emailApiKey = config.email.apiKey;
      if (emailApiKey === undefined) {
        throw new Error('Email is enabled but RESEND_API_KEY is missing.');
      }

      const correspondenceRepo = makeInstitutionCorrespondenceRepo({
        db: userDb,
        logger: repoLogger,
      });
      const emailSender = makeEmailClient({
        apiKey: emailApiKey,
        fromAddress: config.email.fromAddress,
        logger: repoLogger,
      });
      const correspondenceTemplateRenderer = makePublicDebateTemplateRenderer();
      const officialEmailLookup = makeOfficialEmailLookup({
        db: budgetDb,
        logger: repoLogger,
      });
      const selfSendContextLookup = makePublicDebateSelfSendContextLookup({
        db: userDb,
        logger: repoLogger,
      });
      const receivedEmailFetcher = makeReceivedEmailFetcher({
        apiKey: emailApiKey,
        fromAddress: config.email.fromAddress,
        logger: repoLogger,
      });
      const correspondenceInboxAddress = buildSharedCorrespondenceInboxAddress(
        config.institutionCorrespondence.receiveDomain
      );

      learningProgressOnSyncEventsApplied = makePublicDebateRequestSyncHook({
        repo: correspondenceRepo,
        emailSender,
        templateRenderer: correspondenceTemplateRenderer,
        auditCcRecipients: config.institutionCorrespondence.auditCcRecipients,
        platformBaseUrl: config.notifications.platformBaseUrl,
        captureAddress: correspondenceInboxAddress,
        logger: repoLogger,
      });

      await app.register(
        makeInstitutionCorrespondenceRoutes({
          repo: correspondenceRepo,
          emailSender,
          templateRenderer: correspondenceTemplateRenderer,
          auditCcRecipients: config.institutionCorrespondence.auditCcRecipients,
          platformBaseUrl: config.notifications.platformBaseUrl,
          captureAddress: correspondenceInboxAddress,
        })
      );

      if (
        config.institutionCorrespondence.adminRoutesEnabled &&
        config.institutionCorrespondence.adminApiKey !== undefined
      ) {
        await app.register(
          makeInstitutionCorrespondenceAdminRoutes({
            repo: correspondenceRepo,
            apiKey: config.institutionCorrespondence.adminApiKey,
          })
        );
      }

      resendWebhookSideEffects.push(
        makeInstitutionCorrespondenceResendSideEffect({
          repo: correspondenceRepo,
          officialEmailLookup,
          selfSendContextLookup,
          emailEventsRepo:
            emailEventsRepo ??
            makeResendWebhookEmailEventsRepo({
              db: userDb,
              logger: repoLogger,
            }),
          receivedEmailFetcher,
          captureAddress: correspondenceInboxAddress,
          auditCcRecipients: config.institutionCorrespondence.auditCcRecipients,
          logger: repoLogger,
        })
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Notification Delivery Module (Background Jobs + Webhooks)
    // ─────────────────────────────────────────────────────────────────────────
    // This module handles the delivery pipeline for email notifications:
    // - BullMQ workers for collect/compose/send
    // - REST endpoints for manual trigger and webhook ingestion
    // - Role-based gating: api (routes only), worker (workers only), both
    //
    // NOTE: Full integration requires implementing adapters for:
    // - ExtendedNotificationsRepository (findEligibleForDelivery, deactivate)
    // - ExtendedTokensRepository (getOrCreateActive)
    // - DataFetcher (fetchNewsletterData, fetchAlertData)
    // - UserEmailFetcher (getEmail from Clerk)
    //
    // The delivery repos and webhook endpoint are wired here.
    // Workers require the adapters above to function.
    if (config.email.webhookSecret !== undefined) {
      const webhookVerifier = makeWebhookVerifier({
        webhookSecret: config.email.webhookSecret,
        logger: repoLogger,
      });

      const deliveryRepo = makeDeliveryRepo({ db: userDb, logger: repoLogger });
      resendWebhookSideEffects.push(
        makeResendWebhookDeliverySideEffect({
          deliveryRepo,
          notificationsRepo,
          logger: repoLogger,
        })
      );

      const resendWebhookSideEffect =
        resendWebhookSideEffects.length === 1
          ? resendWebhookSideEffects[0]
          : {
              handle: async (input: {
                event: import('../modules/resend-webhooks/index.js').ResendEmailWebhookEvent;
                storedEvent: import('../modules/resend-webhooks/index.js').StoredResendEmailEvent;
              }) => {
                for (const sideEffect of resendWebhookSideEffects) {
                  await sideEffect.handle(input);
                }
              },
            };

      await app.register(
        makeResendWebhookRoutes({
          webhookVerifier,
          emailEventsRepo:
            emailEventsRepo ??
            makeResendWebhookEmailEventsRepo({
              db: userDb,
              logger: repoLogger,
            }),
          logger: repoLogger,
          ...(resendWebhookSideEffect !== undefined ? { sideEffect: resendWebhookSideEffect } : {}),
        })
      );

      app.log.info('Resend webhook endpoint enabled at /api/v1/webhooks/resend');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Learning Progress Module (REST API)
    // ─────────────────────────────────────────────────────────────────────────
    const learningProgressRepo = makeLearningProgressRepo({ db: userDb, logger: repoLogger });

    // Register learning progress routes
    await app.register(
      makeLearningProgressRoutes({
        learningProgressRepo,
        ...(learningProgressOnSyncEventsApplied !== undefined
          ? { onSyncEventsApplied: learningProgressOnSyncEventsApplied }
          : {}),
      })
    );

    if (
      config.learningProgress.reviewApiEnabled &&
      config.learningProgress.reviewApiKey !== undefined
    ) {
      await app.register(
        makeLearningProgressAdminReviewRoutes({
          learningProgressRepo,
          apiKey: config.learningProgress.reviewApiKey,
        })
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Share Module (REST API)
    // ─────────────────────────────────────────────────────────────────────────
    const shortLinkRepo = makeShortLinkRepo({ db: userDb, logger: repoLogger });

    // Build share config from app config
    const shareConfig: ShareConfig = {
      allowedOrigins: [
        ...(config.cors.allowedOrigins
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []),
        ...(config.cors.clientBaseUrl !== undefined ? [config.cors.clientBaseUrl] : []),
        ...(config.cors.publicClientBaseUrl !== undefined ? [config.cors.publicClientBaseUrl] : []),
      ],
      publicBaseUrl: config.cors.publicClientBaseUrl ?? config.cors.clientBaseUrl ?? '',
      dailyLimit: config.shortLinks.dailyLimit,
      cacheTtlSeconds: config.shortLinks.cacheTtlSeconds,
    };

    // Register share routes
    await app.register(
      makeShareRoutes({
        shortLinkRepo,
        cache: noopCache, // Using noop cache - share links are cached at DB level
        hasher: cryptoHasher,
        config: shareConfig,
      })
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Advanced Map Analytics Module (REST API)
    // ─────────────────────────────────────────────────────────────────────────
    const advancedMapAnalyticsRepo = makeAdvancedMapAnalyticsRepo({
      db: userDb,
      logger: repoLogger,
    });

    const groupedSeriesProvider = makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
      budgetDb,
      commitmentsRepo,
      insRepo,
      normalizationService,
      uatAnalyticsRepo,
      cache,
      keyBuilder,
    });

    await app.register(
      makeAdvancedMapAnalyticsRoutes({
        repo: advancedMapAnalyticsRepo,
        groupedSeriesProvider,
        idGenerator: defaultAdvancedMapAnalyticsIdGenerator,
      })
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Advanced Map Analytics Grouped-Series Module (REST API)
    // ─────────────────────────────────────────────────────────────────────────
    await app.register(
      makeAdvancedMapAnalyticsGroupedSeriesRoutes({
        groupedSeriesProvider,
      })
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Setup MCP/GPT Shared Adapters
    // ─────────────────────────────────────────────────────────────────────────
    // Create adapters shared between MCP and GPT REST API
    const mcpEntityAdapter = makeEntityAdapter(entityRepo);
    const mcpUatAdapter = makeUatAdapter(uatRepo);
    const mcpFunctionalAdapter = makeFunctionalClassificationAdapter(functionalClassificationRepo);
    const mcpEconomicAdapter = makeEconomicClassificationAdapter(economicClassificationRepo);
    const mcpExecutionRepo = makeMcpExecutionRepo(budgetDb);
    const mcpAnalyticsService = makeMcpAnalyticsService(analyticsRepo, normalizationService);

    // Create share link adapter
    const publicBaseUrl = config.cors.publicClientBaseUrl ?? config.cors.clientBaseUrl ?? '';
    const mcpShareLink = makeShareLinkAdapter({
      shortLinkRepo,
      publicBaseUrl,
    });

    // Create MCP-adapted repositories
    const mcpEntityAnalyticsAdapter = makeEntityAnalyticsAdapter(rawEntityAnalyticsRepo);
    const mcpAggregatedLineItemsAdapter = makeAggregatedLineItemsAdapter(
      rawAggregatedLineItemsRepo
    );

    // Build MCP config with all required fields
    const mcpConfig: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      authRequired: config.mcp.authRequired,
      ...(config.mcp.apiKey !== undefined && { apiKey: config.mcp.apiKey }),
      sessionTtlSeconds: config.mcp.sessionTtlSeconds,
      clientBaseUrl:
        config.mcp.clientBaseUrl !== ''
          ? config.mcp.clientBaseUrl
          : (config.cors.clientBaseUrl ?? ''),
    };

    // Create rate limiter (shared between MCP and GPT - 100 requests per minute)
    const rateLimiter = makeInMemoryRateLimiter({
      maxRequests: 100,
      windowMs: 60 * 1000, // 1 minute
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Setup MCP Module (Model Context Protocol for AI clients)
    // ─────────────────────────────────────────────────────────────────────────
    if (config.mcp.enabled) {
      // Create MCP server with all dependencies
      const mcpServer = createMcpServer({
        entityRepo: mcpEntityAdapter,
        executionRepo: mcpExecutionRepo,
        uatRepo: mcpUatAdapter,
        functionalClassificationRepo: mcpFunctionalAdapter,
        economicClassificationRepo: mcpEconomicAdapter,
        entityAnalyticsRepo: mcpEntityAnalyticsAdapter,
        analyticsService: mcpAnalyticsService,
        aggregatedLineItemsRepo: mcpAggregatedLineItemsAdapter,
        shareLink: mcpShareLink,
        config: mcpConfig,
      });

      // Create session store (use in-memory for now, can switch to Redis later)
      const sessionStore = makeInMemorySessionStore(config.mcp.sessionTtlSeconds);

      // Register MCP routes
      await app.register(makeMcpRoutes, {
        mcpServer,
        sessionStore,
        rateLimiter,
        config: mcpConfig,
      });

      app.log.info('MCP endpoints enabled at /mcp');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup GPT REST API (always enabled)
    // ─────────────────────────────────────────────────────────────────────────
    // Register OpenAPI spec generator (offline only, no exposed route)
    await app.register(swagger, gptOpenApiConfig);

    // Create GPT routes with same deps as MCP
    const gptRoutesOptions: GptRoutesOptions = {
      deps: {
        entityRepo: mcpEntityAdapter,
        executionRepo: mcpExecutionRepo,
        uatRepo: mcpUatAdapter,
        functionalClassificationRepo: mcpFunctionalAdapter,
        economicClassificationRepo: mcpEconomicAdapter,
        entityAnalyticsRepo: mcpEntityAnalyticsAdapter,
        analyticsService: mcpAnalyticsService,
        aggregatedLineItemsRepo: mcpAggregatedLineItemsAdapter,
        shareLink: mcpShareLink,
        config: { clientBaseUrl: mcpConfig.clientBaseUrl },
      },
      auth: {
        apiKey: config.gpt.apiKey,
      },
      rateLimiter,
    };

    await app.register(makeGptRoutes(gptRoutesOptions));
  }

  return app;
};

/**
 * Build app and prepare it (await all plugins)
 */
export const createApp = async (options: AppOptions = {}): Promise<FastifyInstance> => {
  const app = await buildApp(options);
  await app.ready();
  return app;
};
