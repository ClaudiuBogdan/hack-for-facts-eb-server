/**
 * Fastify application factory
 * Creates and configures the Fastify instance with all plugins and routes
 */

import fastifyLib, {
  type FastifyInstance,
  type FastifyServerOptions,
  type FastifyError,
} from 'fastify';

import { CommonGraphQLSchema } from './common/graphql/index.js';
import { commonGraphQLResolvers } from './common/graphql/schema.js';
import { makeGraphQLPlugin } from './infra/graphql/index.js';
import { BaseSchema } from './infra/graphql/schema.js';
import { registerCors } from './infra/plugins/index.js';
import {
  makeExecutionAnalyticsResolvers,
  ExecutionAnalyticsSchema,
  makeAnalyticsRepo,
} from './modules/execution-analytics/index.js';
import {
  makeHealthRoutes,
  makeHealthResolvers,
  healthSchema,
  type HealthChecker,
} from './modules/health/index.js';

import type { AppConfig } from './infra/config/env.js';
import type { BudgetDbClient } from './infra/database/client.js';
import type { DatasetRepo } from './modules/datasets/index.js';

/**
 * Application dependencies that can be injected
 */
export interface AppDeps {
  healthCheckers?: HealthChecker[];
  budgetDb: BudgetDbClient;
  datasetRepo: DatasetRepo;
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
      checkers: deps.healthCheckers,
    })
  );

  // Setup GraphQL
  const healthResolvers = makeHealthResolvers({
    ...(version !== undefined && { version }),
    checkers: deps.healthCheckers,
  });

  // Setup Analytics Module
  const analyticsRepo = makeAnalyticsRepo(budgetDb);
  const analyticsResolvers = makeExecutionAnalyticsResolvers({
    analyticsRepo,
    datasetRepo,
  });

  // Combine schemas and resolvers
  const schema = [BaseSchema, CommonGraphQLSchema, healthSchema, ExecutionAnalyticsSchema];
  const resolvers = [commonGraphQLResolvers, healthResolvers, analyticsResolvers];

  await app.register(
    makeGraphQLPlugin({
      schema,
      resolvers,
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
