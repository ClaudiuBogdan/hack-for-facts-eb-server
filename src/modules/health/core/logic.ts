import { type HealthCheckResult, type ReadinessResponse } from './types.js';

/**
 * Maps settled promises from health checkers to standardized HealthCheckResults.
 * Handles both successful checks and rejected promises (crashes in checkers).
 */
export const mapCheckResults = (
  results: PromiseSettledResult<HealthCheckResult>[]
): HealthCheckResult[] => {
  return results.map((result) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return {
      name: 'unknown',
      status: 'unhealthy',
      message: result.reason instanceof Error ? result.reason.message : 'Check failed',
    };
  });
};

/**
 * pure business logic to determine system readiness.
 * Aggregates individual check results into a global status.
 */
export const evaluateReadiness = (
  checks: HealthCheckResult[],
  uptime: number,
  timestamp: string,
  version?: string
): ReadinessResponse => {
  const hasUnhealthy = checks.some((c) => c.status === 'unhealthy');
  const status = hasUnhealthy ? 'unhealthy' : 'ok';

  return {
    status,
    timestamp,
    uptime,
    checks,
    ...(version !== undefined && { version }),
  };
};
