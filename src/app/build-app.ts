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
} from './cache-wrappers.js';
import { initCache, createCacheConfig, type CacheClient } from '../infra/cache/index.js';
import { makeWebhookVerifier } from '../infra/email/client.js';
import {
  makeGraphQLPlugin,
  CommonGraphQLSchema,
  commonGraphQLResolvers,
} from '../infra/graphql/index.js';
import { BaseSchema } from '../infra/graphql/schema.js';
import { registerCors, registerSecurityHeaders } from '../infra/plugins/index.js';
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
import {
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
  makeWebhookEventRepo,
  makeWebhookRoutes,
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
import type { BudgetDbClient, UserDbClient } from '../infra/database/client.js';

/**
 * Application dependencies that can be injected
 */
export interface AppDeps {
  healthCheckers?: HealthChecker[];
  budgetDb: BudgetDbClient;
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

/**
 * Creates and configures the Fastify application
 * This is the composition root where all modules are wired together
 */
export const buildApp = async (options: AppOptions = {}): Promise<FastifyInstance> => {
  const { fastifyOptions = {}, deps = {}, version } = options;

  if (deps.budgetDb === undefined || deps.datasetRepo === undefined || deps.config === undefined) {
    throw new Error('Missing required dependencies: budgetDb, datasetRepo, config');
  }

  const budgetDb = deps.budgetDb;
  const datasetRepo = deps.datasetRepo;
  const config = deps.config;

  // Create Fastify instance
  const app = fastifyLib({
    ...fastifyOptions,
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

  // Combine schemas and resolvers
  const schema = [
    BaseSchema,
    CommonGraphQLSchema,
    healthSchema,
    ExecutionAnalyticsSchema,
    AggregatedLineItemsSchema,
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
  ];
  const resolvers = [
    commonGraphQLResolvers,
    healthResolvers,
    analyticsResolvers,
    aggregatedLineItemsResolvers,
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
  ];

  // Create Mercurius loaders for N+1 prevention
  // Combine loaders from all modules
  const executionLineItemLoaders = createExecutionLineItemLoaders(budgetDb);
  const entityLoaders = createEntityLoaders(budgetDb);
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
      app.addHook('preHandler', makeAuthMiddleware({ authProvider: deps.authProvider }));
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
    if (
      config.notifications.enabled &&
      config.email.apiKey !== undefined &&
      config.redis.url !== undefined
    ) {
      // Create delivery repos for the pipeline
      const deliveryRepo = makeDeliveryRepo({ db: userDb, logger: repoLogger });
      const webhookEventRepo = makeWebhookEventRepo({ db: userDb, logger: repoLogger });

      // Log that notification delivery is partially enabled
      app.log.info(
        {
          hasWebhookSecret: config.email.webhookSecret !== undefined,
          hasTriggerApiKey: config.notifications.triggerApiKey !== undefined,
          processRole: config.jobs.processRole,
        },
        'Notification delivery repos initialized (full pipeline requires additional adapters)'
      );

      // Webhook routes (Resend event ingestion) - can work standalone
      if (config.email.webhookSecret !== undefined) {
        const webhookVerifier = makeWebhookVerifier({
          webhookSecret: config.email.webhookSecret,
          logger: repoLogger,
        });

        // Stub notifications repo for webhook routes (just needs deactivate)
        // TODO: Replace with real ExtendedNotificationsRepository when available
        const stubNotificationsRepo = {
          findById: async () => {
            const { ok } = await import('neverthrow');
            return ok(null);
          },
          findEligibleForDelivery: async () => {
            const { ok } = await import('neverthrow');
            return ok([]);
          },
          deactivate: async (id: string) => {
            // Deactivate via base repo
            const { ok } = await import('neverthrow');
            repoLogger.warn({ notificationId: id }, 'Deactivate called but not implemented');
            return ok(undefined);
          },
        };

        await app.register(
          makeWebhookRoutes({
            webhookVerifier,
            webhookEventRepo,
            deliveryRepo,
            notificationsRepo: stubNotificationsRepo,
            logger: repoLogger,
          })
        );

        app.log.info('Resend webhook endpoint enabled at /api/v1/webhooks/resend');
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Learning Progress Module (REST API)
    // ─────────────────────────────────────────────────────────────────────────
    const learningProgressRepo = makeLearningProgressRepo({ db: userDb, logger: repoLogger });

    // Register learning progress routes
    await app.register(
      makeLearningProgressRoutes({
        learningProgressRepo,
      })
    );

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Global Error Handler
  // SECURITY: SEC-005 - Sanitize error messages in production
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Error codes that are safe to expose to clients.
   * These are domain-specific errors with controlled messages.
   */
  const SAFE_ERROR_CODES = new Set([
    'ValidationError',
    'NotFoundError',
    'AuthenticationRequiredError',
    'ForbiddenError',
    'RateLimitExceededError',
    'BadRequestError',
    'ConflictError',
  ]);

  /**
   * Maps HTTP status codes to generic messages for production.
   */
  const GENERIC_MESSAGES: Record<number, string> = {
    400: 'Invalid request',
    401: 'Authentication required',
    403: 'Access denied',
    404: 'Resource not found',
    409: 'Conflict with current state',
    422: 'Unprocessable request',
    429: 'Too many requests',
  };

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Always log full error server-side
    request.log.error({ err: error }, 'Request error');

    const isProduction = config.server.isProduction;

    // Handle validation errors
    if (error.validation != null) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Request validation failed',
        // Only include details in non-production
        ...(isProduction ? {} : { details: error.validation }),
      });
    }

    // Handle known HTTP errors
    if (error.statusCode != null) {
      const statusCode = error.statusCode;
      const isSafeError = SAFE_ERROR_CODES.has(error.name) || SAFE_ERROR_CODES.has(error.code);

      // Safe errors or client errors (4xx) can show their message
      // Server errors (5xx) are hidden in production
      const message =
        isSafeError || statusCode < 500
          ? isProduction
            ? (GENERIC_MESSAGES[statusCode] ?? error.message)
            : error.message
          : isProduction
            ? 'An unexpected error occurred'
            : error.message;

      return reply.status(statusCode).send({
        error: error.name,
        message,
      });
    }

    // Handle unexpected errors - always generic in production
    return reply.status(500).send({
      error: 'InternalServerError',
      message: isProduction ? 'An unexpected error occurred' : error.message,
    });
  });

  // Not found handler
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: 'NotFoundError',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

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
