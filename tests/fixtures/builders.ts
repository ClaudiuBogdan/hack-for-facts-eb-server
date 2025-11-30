/**
 * Test data builders/factories
 * Provides sensible defaults for test entities
 */

import type { HealthCheckResult, HealthChecker } from '@/modules/health/index.js';

/**
 * Create a health check result with defaults
 */
export const makeHealthCheckResult = (
  overrides: Partial<HealthCheckResult> = {}
): HealthCheckResult => ({
  name: 'test-check',
  status: 'healthy',
  ...overrides,
});

/**
 * Create a health checker function that returns a fixed result
 */
export const makeHealthChecker = (result: Partial<HealthCheckResult> = {}): HealthChecker => {
  const fullResult = makeHealthCheckResult(result);
  return async () => fullResult;
};

/**
 * Create a health checker that simulates latency
 */
export const makeSlowHealthChecker = (
  delayMs: number,
  result: Partial<HealthCheckResult> = {}
): HealthChecker => {
  const fullResult = makeHealthCheckResult(result);
  return async () => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ...fullResult,
      latencyMs: Date.now() - start,
    };
  };
};

/**
 * Create a health checker that throws an error
 */
export const makeFailingHealthChecker = (errorMessage: string): HealthChecker => {
  return async () => {
    throw new Error(errorMessage);
  };
};
