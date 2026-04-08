/**
 * Fastify application factory
 * Creates and configures the Fastify instance with all plugins and routes
 */

import { timingSafeEqual } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import fastifyLib, {
  type FastifyInstance,
  type FastifyServerOptions,
  type FastifyError,
} from 'fastify';
import { err, ok, type Result } from 'neverthrow';

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
import { makePublicDebateSelfSendContextLookup } from './public-debate-self-send-context-lookup.js';
import { initCache, type CacheClient } from '../infra/cache/index.js';
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
import { makeUnsubscribeTokenSigner } from '../infra/unsubscribe/token.js';
import {
  createLearningProgressAdminEventSyncHook,
  INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
  makeDefaultAdminEventRegistry,
  queueAdminEvent,
  startAdminEventRuntime,
  type AdminEventRegistry,
  type AdminEventRuntime,
} from '../modules/admin-events/index.js';
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
  makeCampaignSubscriptionStatsReader,
  makeCampaignSubscriptionStatsRoutes,
} from '../modules/campaign-subscription-stats/index.js';
import {
  makeClassificationResolvers,
  ClassificationSchema,
  makeFunctionalClassificationRepo,
  makeEconomicClassificationRepo,
} from '../modules/classification/index.js';
import {
  type ClerkWebhookEvent,
  makeClerkWebhookRoutes,
  makeClerkWebhookVerifier,
} from '../modules/clerk-webhooks/index.js';
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
import { makeEmailRenderer } from '../modules/email-templates/index.js';
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
  createDatabaseError as createCorrespondenceDatabaseError,
  makeInstitutionCorrespondenceAdminRoutes,
  makePublicDebateNotificationOrchestrator,
  makeInstitutionCorrespondenceRepo,
  makeInstitutionCorrespondenceResendSideEffect,
  makeOfficialEmailLookup,
  makePlatformSendSuccessEvidenceLookup,
  makePublicDebateTemplateRenderer,
  startCorrespondenceRecoveryRuntime,
  type CorrespondenceRecoveryRuntime,
  type CorrespondenceRecoveryRuntimeFactory,
  type InstitutionCorrespondenceError,
  type PublicDebateSelfSendApprovalService,
} from '../modules/institution-correspondence/index.js';
import {
  createDatabaseError as createLearningProgressDatabaseError,
  makeLearningProgressAdminReviewRoutes,
  makeLearningProgressRoutes,
  makeLearningProgressRepo,
  syncEvents,
  updateInteractionReview,
  type ApprovedReviewSideEffectPlan,
  type LearningProgressError,
  type ReviewDecision,
  type SyncEventsInput,
} from '../modules/learning-progress/index.js';
import { createLearningProgressPostSyncHookRunner } from '../modules/learning-progress/shell/post-sync-hooks.js';
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
  enqueueTransactionalWelcomeNotification,
  getErrorMessage,
  makeAnafForexebugDigestTriggerRoutes,
  makeBudgetDataFetcher,
  makeClerkUserEmailFetcher,
  makeDeliveryRepo,
  makeExtendedNotificationsRepo,
  makeResendEmailSender,
  makeResendWebhookDeliverySideEffect,
  makeTriggerRoutes,
  startNotificationDeliveryRuntime,
  type NotificationDeliveryRuntime,
  type NotificationDeliveryRuntimeFactory,
} from '../modules/notification-delivery/index.js';
import {
  makeNotificationRoutes,
  makeNotificationsRepo,
  makeDeliveriesRepo,
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
  combineResendWebhookSideEffects,
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
import {
  createLearningProgressUserEventSyncHook,
  makeEntityTermsAcceptedUserEventHandler,
  makeEntityTermsAcceptedSyncHandler,
  makePublicDebateRequestUserEventHandler,
  prepareApprovedPublicDebateReviewSideEffects,
  processLearningProgressAppliedEvents,
  startUserEventRuntime,
  type LearningProgressAppliedEventHandler,
  type UserEventHandler,
  type UserEventRuntime,
  type UserEventRuntimeFactory,
} from '../modules/user-events/index.js';

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
  /** Optional notification delivery runtime factory for tests */
  notificationDeliveryRuntimeFactory?: NotificationDeliveryRuntimeFactory;
  /** Optional user event runtime factory for tests */
  userEventRuntimeFactory?: UserEventRuntimeFactory;
  /** Optional admin event runtime factory for tests */
  adminEventRuntimeFactory?: import('../modules/admin-events/index.js').AdminEventRuntimeFactory;
  /** Optional correspondence recovery runtime factory for tests */
  correspondenceRecoveryRuntimeFactory?: CorrespondenceRecoveryRuntimeFactory;
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
const NOTIFICATION_ADMIN_ROUTE_PREFIX = '/api/v1/admin/notifications';
const GPT_ROUTE_PREFIX = '/api/v1/gpt/';
const WEBHOOK_CLERK_ROUTE_PATH = '/api/v1/webhooks/clerk';
const WEBHOOK_RESEND_ROUTE_PATH = '/api/v1/webhooks/resend';
const NOTIFICATIONS_UNSUBSCRIBE_ROUTE_PREFIX = '/api/v1/notifications/unsubscribe/';
const CAMPAIGN_SUBSCRIPTION_STATS_ROUTE_SUFFIX = '/subscription-stats';
const CAMPAIGN_SUBSCRIPTION_STATS_ROUTE_PREFIX = '/api/v1/campaigns/';
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

function isNotificationAdminRoute(url: string): boolean {
  return getRequestPath(url).startsWith(NOTIFICATION_ADMIN_ROUTE_PREFIX);
}

function isCampaignSubscriptionStatsRoute(url: string): boolean {
  const path = getRequestPath(url);

  return (
    path.startsWith(CAMPAIGN_SUBSCRIPTION_STATS_ROUTE_PREFIX) &&
    path.endsWith(CAMPAIGN_SUBSCRIPTION_STATS_ROUTE_SUFFIX)
  );
}

function shouldBypassGlobalAuthValidation(request: import('fastify').FastifyRequest): boolean {
  const path = getRequestPath(request.url);

  if (request.method === 'OPTIONS') {
    return true;
  }

  if (isHealthRoute(path)) {
    return true;
  }

  if (
    isLearningProgressAdminReviewRoute(path) ||
    isInstitutionCorrespondenceAdminRoute(path) ||
    isNotificationAdminRoute(path)
  ) {
    return true;
  }

  if (
    path === '/mcp' ||
    path === '/openapi.json' ||
    path === WEBHOOK_CLERK_ROUTE_PATH ||
    path === WEBHOOK_RESEND_ROUTE_PATH ||
    path === ADVANCED_MAP_GROUPED_SERIES_ROUTE_PATH ||
    isCampaignSubscriptionStatsRoute(path) ||
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

function hasMatchingSpecialRateLimitKey(
  request: import('fastify').FastifyRequest,
  headerName: string | undefined,
  expectedKey: string | undefined
): boolean {
  if (headerName === undefined || expectedKey === undefined || expectedKey === '') {
    return false;
  }

  const providedKey = request.headers[headerName];
  if (typeof providedKey !== 'string') {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedKey, 'utf-8');
  const providedBuffer = Buffer.from(providedKey, 'utf-8');

  if (expectedBuffer.length !== providedBuffer.length) {
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

class LearningProgressSyncRollbackError extends Error {
  readonly failure: LearningProgressError;

  constructor(failure: LearningProgressError) {
    super('Learning progress sync transaction rolled back');
    this.failure = failure;
  }
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
  const hasBullmqRedisConfig = config.jobs.redisUrl !== undefined && config.jobs.redisUrl !== '';
  const shouldRegisterNotificationAdminRoutes =
    config.notifications.triggerApiKey !== undefined && config.notifications.triggerApiKey !== '';
  const shouldPublishLearningProgressUserEvents = hasBullmqRedisConfig;
  const shouldEnqueueClerkWelcomeNotifications =
    hasBullmqRedisConfig && config.auth.clerkWebhookSigningSecret !== undefined;
  const shouldStartNotificationWorkers = hasBullmqRedisConfig;
  const shouldInitializeNotificationDeliveryRuntime =
    shouldRegisterNotificationAdminRoutes ||
    shouldEnqueueClerkWelcomeNotifications ||
    shouldStartNotificationWorkers;
  const shouldInitializeUserEventRuntime = shouldPublishLearningProgressUserEvents;
  const shouldEnablePublicDebateCorrespondence = deps.userDb !== undefined && config.email.enabled;
  const emailFromAddress = config.email.fromAddress?.trim();
  const funkyEmailFromAddress = config.email.funkyFromAddress?.trim();
  const campaignAuditCcRecipients = config.email.funkyFromAddressCcRecipients;
  const campaignReplyToAddress = config.email.funkyReplyToAddress?.trim();

  if (config.email.enabled && (emailFromAddress === undefined || emailFromAddress === '')) {
    throw new Error('Email is enabled but EMAIL_FROM_ADDRESS is missing.');
  }

  if (
    shouldEnablePublicDebateCorrespondence &&
    (funkyEmailFromAddress === undefined || funkyEmailFromAddress === '')
  ) {
    throw new Error(
      'Public debate campaign email requires FUNKY_EMAIL_FROM_ADDRESS when email is enabled.'
    );
  }

  if (
    shouldEnablePublicDebateCorrespondence &&
    (campaignReplyToAddress === undefined || campaignReplyToAddress === '')
  ) {
    throw new Error(
      'Public debate correspondence requires FUNKY_EMAIL_REPLY_TO_ADDRESS when email is enabled.'
    );
  }

  if (shouldEnablePublicDebateCorrespondence && !hasBullmqRedisConfig) {
    throw new Error(
      'Public debate correspondence requires BULLMQ_REDIS_URL so learning progress requests can dispatch institution email.'
    );
  }

  if (shouldInitializeNotificationDeliveryRuntime && deps.userDb === undefined) {
    throw new Error(
      'Notification delivery runtime requires userDb when notification admin routes or workers are enabled.'
    );
  }

  if (
    shouldInitializeNotificationDeliveryRuntime &&
    (config.jobs.redisUrl === undefined || config.jobs.redisUrl === '')
  ) {
    throw new Error(
      'Notification delivery runtime requires BULLMQ_REDIS_URL when notification admin routes or workers are enabled.'
    );
  }

  if (shouldInitializeUserEventRuntime && deps.userDb === undefined) {
    throw new Error(
      'User event runtime requires userDb when BullMQ background processing is enabled.'
    );
  }

  // Create Fastify instance
  const app = fastifyLib({
    ...fastifyOptions,
    routerOptions: {
      maxParamLength: 512,
      ...fastifyOptions.routerOptions,
    },
  });
  const repoLogger = app.log as unknown as import('pino').Logger;

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
  let notificationDeliveryRuntime: NotificationDeliveryRuntime | undefined;
  let correspondenceRecoveryRuntime: CorrespondenceRecoveryRuntime | undefined;
  let userEventRuntime: UserEventRuntime | undefined;
  let adminEventRuntime: AdminEventRuntime | undefined;
  let adminEventRegistry: AdminEventRegistry | undefined;
  let onClerkWebhookEventVerified:
    | ((input: { event: ClerkWebhookEvent; svixId: string }) => Promise<void>)
    | undefined;

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

  // Register global rate limiting
  const rateLimitMax = config.rateLimit.max;
  const rateLimitWindow = config.rateLimit.window;
  const rateLimitSpecialHeader = config.rateLimit.specialHeader;
  const rateLimitSpecialKey = config.rateLimit.specialKey;
  const rateLimitSpecialMax = config.rateLimit.specialMax;

  await app.register(rateLimit, {
    max: (request) => {
      // Allow higher limits only for trusted service-to-service calls.
      if (hasMatchingSpecialRateLimitKey(request, rateLimitSpecialHeader, rateLimitSpecialKey)) {
        return rateLimitSpecialMax;
      }
      return rateLimitMax;
    },
    timeWindow: rateLimitWindow,
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Cache Infrastructure
  // ─────────────────────────────────────────────────────────────────────────────
  const { cache, keyBuilder, rawCache } =
    deps.cacheClient ?? initCache({ config: config.cache, logger: repoLogger });

  app.addHook('onClose', async () => {
    await rawCache.close?.();
  });

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
    const notificationsRepo = makeNotificationsRepo({ db: userDb, logger: repoLogger });
    const extendedNotificationsRepo = makeExtendedNotificationsRepo({
      db: userDb,
      logger: repoLogger,
    });
    const deliveriesRepo = makeDeliveriesRepo({ db: userDb, logger: repoLogger });
    const deliveryRepo = makeDeliveryRepo({ db: userDb, logger: repoLogger });
    const learningProgressRepo = makeLearningProgressRepo({ db: userDb, logger: repoLogger });
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
    const userEventHandlers: UserEventHandler[] = [];
    const learningProgressSyncHooks: {
      name: string;
      run(input: {
        userId: string;
        events: readonly import('../modules/learning-progress/index.js').LearningProgressEvent[];
      }): Promise<void>;
    }[] = [];
    let learningProgressOnSyncEventsApplied:
      | ((input: {
          userId: string;
          events: readonly import('../modules/learning-progress/index.js').LearningProgressEvent[];
        }) => Promise<void>)
      | undefined;
    let prepareApproveLearningProgressReviews:
      | ((input: {
          items: readonly ReviewDecision[];
        }) => Promise<
          Result<
            ApprovedReviewSideEffectPlan | null,
            LearningProgressError | InstitutionCorrespondenceError
          >
        >)
      | undefined;

    const unsubscribeSecret = config.notifications.unsubscribeHmacSecret?.trim();

    if (unsubscribeSecret === undefined || unsubscribeSecret === '') {
      throw new Error(
        'Notification routes require UNSUBSCRIBE_HMAC_SECRET (min 32 chars) when userDb is enabled.'
      );
    }
    const tokenSigner = makeUnsubscribeTokenSigner(unsubscribeSecret);

    // Register notification routes
    await app.register(
      makeNotificationRoutes({
        notificationsRepo,
        deliveriesRepo,
        tokenSigner,
        hasher: sha256Hasher,
      })
    );

    const campaignSubscriptionStatsReader = makeCampaignSubscriptionStatsReader({
      userDb,
      budgetDb,
      logger: repoLogger,
      cache,
      keyBuilder,
    });

    await app.register(
      makeCampaignSubscriptionStatsRoutes({
        reader: campaignSubscriptionStatsReader,
      })
    );

    if (shouldStartNotificationWorkers && config.auth.clerkSecretKey === undefined) {
      throw new Error(
        'Notification delivery requires CLERK_SECRET_KEY when BullMQ workers are enabled.'
      );
    }

    if (
      shouldStartNotificationWorkers &&
      (config.email.apiKey === undefined || config.email.apiKey === '')
    ) {
      throw new Error(
        'Notification delivery requires RESEND_API_KEY when BullMQ workers are enabled.'
      );
    }

    if (
      shouldStartNotificationWorkers &&
      (emailFromAddress === undefined || emailFromAddress === '')
    ) {
      throw new Error(
        'Notification delivery requires EMAIL_FROM_ADDRESS when BullMQ workers are enabled.'
      );
    }

    if (shouldStartNotificationWorkers && config.notifications.platformBaseUrl === '') {
      throw new Error(
        'Notification delivery requires PUBLIC_CLIENT_BASE_URL when BullMQ workers are enabled.'
      );
    }

    if (shouldInitializeNotificationDeliveryRuntime) {
      const createNotificationDeliveryRuntime =
        deps.notificationDeliveryRuntimeFactory ?? startNotificationDeliveryRuntime;

      notificationDeliveryRuntime = await createNotificationDeliveryRuntime({
        redisUrl: config.jobs.redisUrl ?? '',
        bullmqPrefix: config.jobs.prefix,
        logger: repoLogger,
        concurrency: config.jobs.concurrency,
        intervalMinutes: config.jobs.notificationRecoverySweepIntervalMinutes,
        thresholdMinutes: config.jobs.notificationStuckSendingThresholdMinutes,
        ...(config.jobs.redisPassword !== undefined
          ? { redisPassword: config.jobs.redisPassword }
          : {}),
        ...(shouldStartNotificationWorkers
          ? {
              workerDeps: {
                deliveryRepo,
                notificationsRepo: extendedNotificationsRepo,
                userEmailFetcher: makeClerkUserEmailFetcher({
                  secretKey: config.auth.clerkSecretKey ?? '',
                  logger: repoLogger,
                }),
                emailSender: makeResendEmailSender({
                  sender: makeEmailClient({
                    apiKey: config.email.apiKey ?? '',
                    fromAddress: emailFromAddress ?? '',
                    logger: repoLogger,
                  }),
                  ...(funkyEmailFromAddress !== undefined && funkyEmailFromAddress !== ''
                    ? {
                        campaignSender: makeEmailClient({
                          apiKey: config.email.apiKey ?? '',
                          fromAddress: funkyEmailFromAddress,
                          logger: repoLogger,
                        }),
                      }
                    : {}),
                }),
                tokenSigner,
                dataFetcher: makeBudgetDataFetcher({
                  entityRepo,
                  entityProfileRepo,
                  entityAnalyticsSummaryRepo,
                  aggregatedLineItemsRepo: rawAggregatedLineItemsRepo,
                  normalization: normalizationService,
                  populationRepo: rawPopulationRepo,
                  datasetRepo,
                  logger: repoLogger,
                }),
                emailRenderer: makeEmailRenderer({ logger: repoLogger }),
                platformBaseUrl: config.notifications.platformBaseUrl,
                apiBaseUrl: config.notifications.apiBaseUrl,
                environment: config.server.isProduction
                  ? 'production'
                  : config.server.isDevelopment
                    ? 'development'
                    : 'test',
                maxSendRps: config.email.maxRps,
              },
            }
          : {}),
      });

      if (
        shouldRegisterNotificationAdminRoutes &&
        config.notifications.triggerApiKey !== undefined
      ) {
        await app.register(
          makeTriggerRoutes({
            collectQueue: notificationDeliveryRuntime.collectQueue,
            notificationsRepo: extendedNotificationsRepo,
            triggerApiKey: config.notifications.triggerApiKey,
            logger: repoLogger,
          }),
          { prefix: NOTIFICATION_ADMIN_ROUTE_PREFIX }
        );

        await app.register(
          makeAnafForexebugDigestTriggerRoutes({
            notificationsRepo: extendedNotificationsRepo,
            deliveryRepo,
            composeJobScheduler: notificationDeliveryRuntime.composeJobScheduler,
            triggerApiKey: config.notifications.triggerApiKey,
            logger: repoLogger,
          }),
          { prefix: NOTIFICATION_ADMIN_ROUTE_PREFIX }
        );
      }

      if (shouldEnqueueClerkWelcomeNotifications) {
        const composeJobScheduler = notificationDeliveryRuntime.composeJobScheduler;
        onClerkWebhookEventVerified = async ({ event, svixId }) => {
          if (event.type !== 'user.created') {
            return;
          }

          const userId = typeof event.data['id'] === 'string' ? event.data['id'].trim() : '';
          if (userId.length === 0) {
            repoLogger.warn(
              { svixId, eventType: event.type },
              'Skipping Clerk welcome enqueue because user id is missing'
            );
            return;
          }

          const registeredAt = new Date(event.timestamp);
          if (Number.isNaN(registeredAt.getTime())) {
            repoLogger.warn(
              { svixId, eventType: event.type, timestamp: event.timestamp },
              'Skipping Clerk welcome enqueue because timestamp is invalid'
            );
            return;
          }

          const enqueueResult = await enqueueTransactionalWelcomeNotification(
            {
              deliveryRepo,
              composeJobScheduler,
            },
            {
              runId: `clerk-${svixId}`,
              source: 'clerk_webhook.user_created',
              sourceEventId: svixId,
              userId,
              registeredAt: registeredAt.toISOString(),
            }
          );

          if (enqueueResult.isErr()) {
            throw new Error(getErrorMessage(enqueueResult.error));
          }
        };
      }
    }

    if (notificationDeliveryRuntime?.composeJobScheduler !== undefined) {
      userEventHandlers.push(
        makeEntityTermsAcceptedUserEventHandler({
          learningProgressRepo,
          notificationsRepo,
          deliveryRepo,
          composeJobScheduler: notificationDeliveryRuntime.composeJobScheduler,
          entityRepo,
          logger: repoLogger,
        })
      );
    }

    const createLearningProgressSyncHandlers = (
      db: Parameters<typeof makeNotificationsRepo>[0]['db']
    ): readonly LearningProgressAppliedEventHandler[] => [
      makeEntityTermsAcceptedSyncHandler({
        notificationsRepo: makeNotificationsRepo({ db, logger: repoLogger }),
        hasher: sha256Hasher,
        logger: repoLogger,
      }),
    ];

    const learningProgressSyncEventsWithSideEffects = async (input: SyncEventsInput) => {
      try {
        const value = await userDb.transaction().execute(async (transaction) => {
          const transactionalLearningProgressRepo = makeLearningProgressRepo({
            db: transaction,
            logger: repoLogger,
            transactionScoped: true,
          });

          const syncResult = await syncEvents({ repo: transactionalLearningProgressRepo }, input);

          if (syncResult.isErr()) {
            throw new LearningProgressSyncRollbackError(syncResult.error);
          }

          if (syncResult.value.appliedEvents.length > 0) {
            await processLearningProgressAppliedEvents(
              {
                handlers: createLearningProgressSyncHandlers(transaction),
                logger: repoLogger,
              },
              {
                userId: input.userId,
                events: syncResult.value.appliedEvents,
              }
            );
          }

          return syncResult.value;
        });

        return ok(value);
      } catch (error) {
        if (error instanceof LearningProgressSyncRollbackError) {
          return err(error.failure);
        }

        return err(
          createLearningProgressDatabaseError(
            'Failed to execute learning progress sync with synchronous side effects',
            error
          )
        );
      }
    };

    const publicDebateSelfSendApprovalService: PublicDebateSelfSendApprovalService = {
      async approvePendingRecord({ userId, recordKey }) {
        const recordResult = await learningProgressRepo.getRecord(userId, recordKey);
        if (recordResult.isErr()) {
          return err(
            createCorrespondenceDatabaseError(
              'Failed to load learning progress record for self-send approval',
              recordResult.error
            )
          );
        }

        const recordRow = recordResult.value;
        if (recordRow?.record.phase !== 'pending') {
          return ok(undefined);
        }

        const reviewResult = await updateInteractionReview(
          { repo: learningProgressRepo },
          {
            userId,
            recordKey,
            expectedUpdatedAt: recordRow.updatedAt,
            status: 'approved',
          }
        );

        if (reviewResult.isErr()) {
          if (
            reviewResult.error.type === 'ConflictError' &&
            reviewResult.error.message.includes('is no longer reviewable because it is not pending')
          ) {
            return ok(undefined);
          }

          return err(
            createCorrespondenceDatabaseError(
              'Failed to approve self-send learning progress record',
              reviewResult.error
            )
          );
        }

        return ok(undefined);
      },
    };

    const publicDebateComposeJobScheduler = notificationDeliveryRuntime?.composeJobScheduler;

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Institution Correspondence Module (Admin REST API + Webhook Side Effects)
    // ─────────────────────────────────────────────────────────────────────────
    if (config.email.enabled) {
      const emailApiKey = config.email.apiKey;
      if (emailApiKey === undefined || emailApiKey === '') {
        throw new Error('Email is enabled but RESEND_API_KEY is missing.');
      }

      const correspondenceRepo = makeInstitutionCorrespondenceRepo({
        db: userDb,
        logger: repoLogger,
      });
      const emailSender = makeEmailClient({
        apiKey: emailApiKey,
        fromAddress: funkyEmailFromAddress ?? '',
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
      const platformSendSuccessEvidenceLookup = makePlatformSendSuccessEvidenceLookup({
        db: userDb,
        logger: repoLogger,
      });
      const receivedEmailFetcher = makeReceivedEmailFetcher({
        apiKey: emailApiKey,
        fromAddress: funkyEmailFromAddress ?? '',
        logger: repoLogger,
      });
      const correspondenceInboxAddress = campaignReplyToAddress ?? '';
      if (publicDebateComposeJobScheduler === undefined) {
        throw new Error(
          'Public debate correspondence requires notification delivery compose scheduling.'
        );
      }

      const publicDebateNotificationOrchestrator = makePublicDebateNotificationOrchestrator({
        repo: correspondenceRepo,
        entityRepo,
        notificationsRepo,
        extendedNotificationsRepo,
        deliveryRepo,
        composeJobScheduler: publicDebateComposeJobScheduler,
        hasher: sha256Hasher,
        campaignAuditCcRecipients,
        logger: repoLogger,
      });
      const publicDebateUpdatePublisher = publicDebateNotificationOrchestrator.updatePublisher;
      const publicDebateSubscriptionService =
        publicDebateNotificationOrchestrator.subscriptionService;

      userEventHandlers.push(
        makePublicDebateRequestUserEventHandler({
          learningProgressRepo,
          entityRepo,
          entityProfileRepo,
          repo: correspondenceRepo,
          emailSender,
          templateRenderer: correspondenceTemplateRenderer,
          auditCcRecipients: campaignAuditCcRecipients,
          platformBaseUrl: config.notifications.platformBaseUrl,
          captureAddress: correspondenceInboxAddress,
          subscriptionService: publicDebateSubscriptionService,
          updatePublisher: publicDebateUpdatePublisher,
          logger: repoLogger,
        })
      );

      prepareApproveLearningProgressReviews = async (input) => {
        return prepareApprovedPublicDebateReviewSideEffects(
          {
            learningProgressRepo,
            entityRepo,
            entityProfileRepo,
            repo: correspondenceRepo,
            emailSender,
            templateRenderer: correspondenceTemplateRenderer,
            auditCcRecipients: campaignAuditCcRecipients,
            platformBaseUrl: config.notifications.platformBaseUrl,
            captureAddress: correspondenceInboxAddress,
            subscriptionService: publicDebateSubscriptionService,
            updatePublisher: publicDebateUpdatePublisher,
          },
          input
        );
      };

      if (hasBullmqRedisConfig && adminEventRuntime === undefined) {
        const createAdminEventRuntime = deps.adminEventRuntimeFactory ?? startAdminEventRuntime;

        adminEventRuntime = await createAdminEventRuntime({
          redisUrl: config.jobs.redisUrl ?? '',
          bullmqPrefix: config.jobs.prefix,
          logger: repoLogger,
          ...(config.jobs.redisPassword !== undefined
            ? { redisPassword: config.jobs.redisPassword }
            : {}),
        });

        adminEventRegistry = makeDefaultAdminEventRegistry({
          learningProgressRepo,
          institutionCorrespondenceRepo: correspondenceRepo,
          prepareApproveLearningProgressReviews,
        });
      }

      if (
        config.institutionCorrespondence.adminRoutesEnabled &&
        config.institutionCorrespondence.adminApiKey !== undefined
      ) {
        await app.register(
          makeInstitutionCorrespondenceAdminRoutes({
            repo: correspondenceRepo,
            apiKey: config.institutionCorrespondence.adminApiKey,
            updatePublisher: publicDebateUpdatePublisher,
          })
        );
      }

      const pendingReplyAdminEventHook =
        adminEventRegistry !== undefined && adminEventRuntime !== undefined
          ? (() => {
              const registry = adminEventRegistry;
              const queue = adminEventRuntime.queue;

              return async (eventInput: { threadId: string; basedOnEntryId: string }) => {
                const queueResult = await queueAdminEvent(
                  {
                    registry,
                    queue,
                  },
                  {
                    eventType: INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
                    payload: eventInput,
                  }
                );
                if (queueResult.isErr()) {
                  throw new Error(queueResult.error.message);
                }
              };
            })()
          : undefined;

      resendWebhookSideEffects.push(
        makeInstitutionCorrespondenceResendSideEffect({
          repo: correspondenceRepo,
          officialEmailLookup,
          selfSendContextLookup,
          selfSendApprovalService: publicDebateSelfSendApprovalService,
          emailEventsRepo:
            emailEventsRepo ??
            makeResendWebhookEmailEventsRepo({
              db: userDb,
              logger: repoLogger,
            }),
          receivedEmailFetcher,
          captureAddress: correspondenceInboxAddress,
          auditCcRecipients: campaignAuditCcRecipients,
          updatePublisher: publicDebateUpdatePublisher,
          ...(pendingReplyAdminEventHook !== undefined
            ? { onPendingReplyCreated: pendingReplyAdminEventHook }
            : {}),
          logger: repoLogger,
        })
      );

      if (hasBullmqRedisConfig) {
        const createCorrespondenceRecoveryRuntime =
          deps.correspondenceRecoveryRuntimeFactory ?? startCorrespondenceRecoveryRuntime;

        correspondenceRecoveryRuntime = await createCorrespondenceRecoveryRuntime({
          redisUrl: config.jobs.redisUrl ?? '',
          bullmqPrefix: config.jobs.prefix,
          repo: correspondenceRepo,
          evidenceLookup: platformSendSuccessEvidenceLookup,
          notificationsRepo: extendedNotificationsRepo,
          deliveryRepo,
          updatePublisher: publicDebateUpdatePublisher,
          logger: repoLogger,
          intervalMinutes: config.jobs.notificationRecoverySweepIntervalMinutes,
          thresholdMinutes: config.jobs.notificationStuckSendingThresholdMinutes,
          ...(config.jobs.redisPassword !== undefined
            ? { redisPassword: config.jobs.redisPassword }
            : {}),
        });
      }
    }

    if (hasBullmqRedisConfig && adminEventRuntime === undefined) {
      const createAdminEventRuntime = deps.adminEventRuntimeFactory ?? startAdminEventRuntime;

      adminEventRuntime = await createAdminEventRuntime({
        redisUrl: config.jobs.redisUrl ?? '',
        bullmqPrefix: config.jobs.prefix,
        logger: repoLogger,
        ...(config.jobs.redisPassword !== undefined
          ? { redisPassword: config.jobs.redisPassword }
          : {}),
      });

      adminEventRegistry = makeDefaultAdminEventRegistry({
        learningProgressRepo,
        ...(prepareApproveLearningProgressReviews !== undefined
          ? { prepareApproveLearningProgressReviews }
          : {}),
      });
    }

    if (adminEventRegistry !== undefined && adminEventRuntime !== undefined) {
      learningProgressSyncHooks.push({
        name: 'admin-events-review-pending',
        run: createLearningProgressAdminEventSyncHook({
          registry: adminEventRegistry,
          queue: adminEventRuntime.queue,
          learningProgressRepo,
          logger: repoLogger,
        }),
      });
    }

    if (shouldInitializeUserEventRuntime) {
      const createUserEventRuntime = deps.userEventRuntimeFactory ?? startUserEventRuntime;

      userEventRuntime = await createUserEventRuntime({
        redisUrl: config.jobs.redisUrl ?? '',
        bullmqPrefix: config.jobs.prefix,
        logger: repoLogger,
        concurrency: config.jobs.concurrency,
        handlers: userEventHandlers,
        ...(config.jobs.redisPassword !== undefined
          ? { redisPassword: config.jobs.redisPassword }
          : {}),
      });

      learningProgressSyncHooks.push({
        name: 'user-events',
        run: createLearningProgressUserEventSyncHook({
          publisher: userEventRuntime.publisher,
          logger: repoLogger,
        }),
      });
    }

    if (learningProgressSyncHooks.length > 0) {
      learningProgressOnSyncEventsApplied = createLearningProgressPostSyncHookRunner({
        hooks: learningProgressSyncHooks,
        logger: repoLogger,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Notification Delivery Module (Background Jobs + Webhooks)
    // ─────────────────────────────────────────────────────────────────────────
    // This module handles the delivery pipeline for email notifications:
    // - BullMQ workers for collect/compose/send
    // - REST endpoints for manual trigger and webhook ingestion
    // - Shared startup: any process with BullMQ configured runs producers and workers
    //
    // The shared runtime now owns the BullMQ queues, workers, and recovery scheduler.
    // Admin trigger routes are mounted under /api/v1/admin/notifications and protected
    // by the existing API key plus Istio's /api/v1/admin/ ingress block.
    if (config.email.webhookSecret !== undefined) {
      const webhookVerifier = makeWebhookVerifier({
        webhookSecret: config.email.webhookSecret,
        logger: repoLogger,
      });

      resendWebhookSideEffects.push(
        makeResendWebhookDeliverySideEffect({
          deliveryRepo,
          notificationsRepo,
          logger: repoLogger,
        })
      );

      const resendWebhookSideEffect = combineResendWebhookSideEffects(
        resendWebhookSideEffects,
        repoLogger
      );

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
    // Register learning progress routes
    await app.register(
      makeLearningProgressRoutes({
        learningProgressRepo,
        syncEventsWithSideEffects: learningProgressSyncEventsWithSideEffects,
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
          ...(prepareApproveLearningProgressReviews !== undefined
            ? { prepareApproveReviews: prepareApproveLearningProgressReviews }
            : {}),
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

  if (config.auth.clerkWebhookSigningSecret !== undefined) {
    const clerkWebhookVerifier = makeClerkWebhookVerifier({
      signingSecret: config.auth.clerkWebhookSigningSecret,
      logger: repoLogger,
    });

    await app.register(
      makeClerkWebhookRoutes({
        webhookVerifier: clerkWebhookVerifier,
        logger: repoLogger,
        ...(onClerkWebhookEventVerified !== undefined
          ? { onEventVerified: onClerkWebhookEventVerified }
          : {}),
      })
    );

    app.log.info('Clerk webhook endpoint enabled at /api/v1/webhooks/clerk');
  }

  if (notificationDeliveryRuntime !== undefined) {
    app.addHook('onClose', async () => {
      await notificationDeliveryRuntime.stop();
    });
  }

  if (correspondenceRecoveryRuntime !== undefined) {
    app.addHook('onClose', async () => {
      await correspondenceRecoveryRuntime.stop();
    });
  }

  if (userEventRuntime !== undefined) {
    app.addHook('onClose', async () => {
      await userEventRuntime.stop();
    });
  }

  if (adminEventRuntime !== undefined) {
    app.addHook('onClose', async () => {
      await adminEventRuntime.stop();
    });
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
