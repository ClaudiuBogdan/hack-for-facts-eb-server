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
  type DatasetRepo,
  DatasetsSchema,
  makeDatasetsResolvers,
} from '../modules/datasets/index.js';
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
  const populationRepo = makePopulationRepo(budgetDb);

  // Setup Analytics Module
  const analyticsRepo = makeAnalyticsRepo(budgetDb);
  const analyticsResolvers = makeExecutionAnalyticsResolvers({
    analyticsRepo,
    datasetRepo,
    populationRepo,
  });

  // Setup Aggregated Line Items Module
  const normalizationService = await NormalizationService.create(datasetRepo);
  const aggregatedLineItemsRepo = makeAggregatedLineItemsRepo(budgetDb);
  const aggregatedLineItemsResolvers = makeAggregatedLineItemsResolvers({
    repo: aggregatedLineItemsRepo,
    normalization: normalizationService,
    populationRepo,
  });

  // Setup Entity Analytics Module
  const entityAnalyticsRepo = makeEntityAnalyticsRepo(budgetDb);
  const entityAnalyticsResolvers = makeEntityAnalyticsResolvers({
    repo: entityAnalyticsRepo,
    normalization: normalizationService,
  });

  // Setup Datasets Module (GraphQL interface for static datasets)
  const datasetsResolvers = makeDatasetsResolvers({
    datasetRepo,
  });

  // Setup Budget Sector Module
  const budgetSectorRepo = deps.budgetSectorRepo ?? makeBudgetSectorRepo(budgetDb);
  const budgetSectorResolvers = makeBudgetSectorResolvers({
    budgetSectorRepo,
  });

  // Setup Funding Source Module
  const fundingSourceRepo = deps.fundingSourceRepo ?? makeFundingSourceRepo(budgetDb);
  const executionLineItemRepo = deps.executionLineItemRepo ?? makeExecutionLineItemRepo(budgetDb);
  const fundingSourceResolvers = makeFundingSourceResolvers({
    fundingSourceRepo,
    executionLineItemRepo,
  });

  // Setup Execution Line Items Module (standalone queries with DataLoaders)
  const executionLineItemsModuleRepo =
    deps.executionLineItemsModuleRepo ?? makeExecutionLineItemsModuleRepo(budgetDb);
  const executionLineItemsResolvers = makeExecutionLineItemResolvers({
    executionLineItemRepo: executionLineItemsModuleRepo,
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
  ];

  // Create Mercurius loaders for N+1 prevention
  const executionLineItemLoaders = createExecutionLineItemLoaders(budgetDb);

  await app.register(
    makeGraphQLPlugin({
      schema,
      resolvers,
      loaders: executionLineItemLoaders,
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
