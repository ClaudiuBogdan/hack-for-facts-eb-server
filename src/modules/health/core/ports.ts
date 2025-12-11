import type { HealthCheckResult } from './types.js';

/**
 * Health check function type
 */
export type HealthChecker = () => Promise<HealthCheckResult>;
