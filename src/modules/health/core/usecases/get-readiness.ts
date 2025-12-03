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
    };
  });
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

  // Evaluate overall status
  const hasUnhealthy = checks.some((c) => c.status === 'unhealthy');
  const status = hasUnhealthy ? 'unhealthy' : 'ok';

  return {
    status,
    timestamp,
    uptime,
    checks,
    ...(version !== undefined && { version }),
  };
}
