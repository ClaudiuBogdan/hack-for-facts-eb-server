/**
 * Health module exports
 */

// Routes and resolvers
export { makeHealthRoutes } from './shell/rest/routes.js';
export { makeHealthResolvers } from './shell/graphql/resolvers.js';
export { schema as healthSchema } from './shell/graphql/schema.js';

// Health checker factories
export {
  makeDbHealthChecker,
  makeCacheHealthChecker,
  type DbHealthCheckerOptions,
  type CacheHealthCheckerOptions,
} from './shell/checkers/index.js';

// Types
export type { HealthChecker } from './core/ports.js';
export type { HealthCheckResult, LivenessResponse, ReadinessResponse } from './core/types.js';
