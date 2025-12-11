import type { HealthChecker } from '../ports.js';
import type { HealthCheckResult, ReadinessResponse } from '../types.js';

export interface GetReadinessDeps {
  checkers: HealthChecker[];
  version?: string | undefined;
}

export interface GetReadinessInput {
  uptime: number;
  timestamp: string;
}

/**
 * Maps settled promises from health checkers to standardized HealthCheckResults.
 * Rejected promises are treated as critical failures (critical: true by default).
 */
const mapCheckResults = (
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
      critical: true, // Rejected checks are critical by default
    };
  });
};

/**
 * Determines overall status based on check results.
 * - Any critical unhealthy → "unhealthy" (503)
 * - Any non-critical unhealthy → "degraded" (200)
 * - All healthy → "ok" (200)
 */
const determineOverallStatus = (checks: HealthCheckResult[]): 'ok' | 'degraded' | 'unhealthy' => {
  const hasCriticalUnhealthy = checks.some((c) => c.status === 'unhealthy' && c.critical !== false);
  if (hasCriticalUnhealthy) {
    return 'unhealthy';
  }

  const hasNonCriticalUnhealthy = checks.some(
    (c) => c.status === 'unhealthy' && c.critical === false
  );
  if (hasNonCriticalUnhealthy) {
    return 'degraded';
  }

  return 'ok';
};

/**
 * Use case to determine system readiness.
 * Executes all health checkers and aggregates the results.
 */
export async function getReadiness(
  deps: GetReadinessDeps,
  input: GetReadinessInput
): Promise<ReadinessResponse> {
  const { checkers = [], version } = deps;
  const { uptime, timestamp } = input;

  // Run all health checkers in parallel
  const results = await Promise.allSettled(checkers.map((checker) => checker()));

  // Map results
  const checks = mapCheckResults(results);

  // Evaluate overall status based on critical/non-critical checks
  const status = determineOverallStatus(checks);

  return {
    status,
    timestamp,
    uptime,
    checks,
    ...(version !== undefined && { version }),
  };
}
