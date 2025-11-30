/**
 * Health module exports
 */

export { makeHealthRoutes } from './shell/rest/routes.js';
export { makeHealthResolvers } from './shell/graphql/resolvers.js';
export { schema as healthSchema } from './shell/graphql/schema.js';

export type {
  HealthDeps,
  HealthChecker,
  HealthCheckResult,
  LivenessResponse,
  ReadinessResponse,
} from './core/types.js';
