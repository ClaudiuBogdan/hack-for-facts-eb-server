/**
 * Health module exports
 */

export { makeHealthRoutes } from './routes.js';
export type {
  HealthDeps,
  HealthChecker,
  HealthCheckResult,
  LivenessResponse,
  ReadinessResponse,
} from './types.js';
