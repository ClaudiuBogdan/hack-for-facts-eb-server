/**
 * Fastify application factory
 * Creates and configures the Fastify instance with all plugins and routes
 */

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
import {
  makeGraphQLPlugin,
  CommonGraphQLSchema,
  commonGraphQLResolvers,
} from '../infra/graphql/index.js';
import { BaseSchema } from '../infra/graphql/schema.js';
import { registerCors } from '../infra/plugins/index.js';
import {
  makeAggregatedLineItemsResolvers,
  AggregatedLineItemsSchema,
  makeAggregatedLineItemsRepo,
  makePopulationRepo,
} from '../modules/aggregated-line-items/index.js';
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
  type HealthChecker,
} from '../modules/health/index.js';
import { NormalizationService } from '../modules/normalization/index.js';
import {
  makeReportResolvers,
  ReportSchema,
  makeReportRepo,
  createReportLoaders,
} from '../modules/report/index.js';
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
import type { BudgetDbClient } from '../infra/database/client.js';

/**
 * Application dependencies that can be injected
 */
export interface AppDeps {
  healthCheckers?: HealthChecker[];
  budgetDb: BudgetDbClient;
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Cache Infrastructure
  // ─────────────────────────────────────────────────────────────────────────────
  const cacheConfig = createCacheConfig(process.env);
  const { cache, keyBuilder } =
    deps.cacheClient ??
    initCache({ config: cacheConfig, logger: app.log as unknown as import('pino').Logger });

  // Register health routes
  await app.register(
    makeHealthRoutes({
      ...(version !== undefined && { version }),
      checkers: deps.healthCheckers ?? [],
    })
  );

  // Setup GraphQL
  const healthResolvers = makeHealthResolvers({
    ...(version !== undefined && { version }),
    checkers: deps.healthCheckers ?? [],
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

  await app.register(
    makeGraphQLPlugin({
      schema,
      resolvers,
      loaders: combinedLoaders,
    })
  );

  // Global error handler
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'Request error');

    // Handle validation errors
    if (error.validation != null) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Request validation failed',
        details: error.validation,
      });
    }

    // Handle known HTTP errors
    if (error.statusCode != null) {
      return reply.status(error.statusCode).send({
        error: error.name,
        message: error.message,
      });
    }

    // Handle unexpected errors
    return reply.status(500).send({
      error: 'InternalServerError',
      message: 'An unexpected error occurred',
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
