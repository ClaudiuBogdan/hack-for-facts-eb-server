/**
 * Health module exports
 */

export { makeHealthRoutes } from './shell/rest/routes.js';
export { makeHealthResolvers } from './shell/graphql/resolvers.js';
export { schema as healthSchema } from './shell/graphql/schema.js';

export type { HealthChecker } from './core/ports.js';
export type { HealthCheckResult, LivenessResponse, ReadinessResponse } from './core/types.js';
