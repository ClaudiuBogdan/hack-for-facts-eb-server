/**
 * Database health checker
 *
 * Executes a simple `SELECT 1` query to verify database connectivity.
 * Returns unhealthy if the query fails or times out.
 */

import { sql, type Kysely } from 'kysely';

import type { HealthChecker } from '../../core/ports.js';
import type { HealthCheckResult } from '../../core/types.js';

/** Default timeout for database health check in milliseconds */
const DEFAULT_TIMEOUT_MS = 3000;

export interface DbHealthCheckerOptions {
  /** Name to identify this database in health check results */
  name: string;
  /** Timeout in milliseconds (default: 3000) */
  timeoutMs?: number;
}

/**
 * Creates a health checker for a Kysely database client.
 *
 * @param db - Kysely database client
 * @param options - Checker configuration
 * @returns HealthChecker function
 *
 * @example
 * ```typescript
 * const dbChecker = makeDbHealthChecker(budgetDb, { name: 'database' });
 * const result = await dbChecker();
 * // { name: 'database', status: 'healthy', latencyMs: 5, critical: true }
 * ```
 */
export const makeDbHealthChecker = <T>(
  db: Kysely<T>,
  options: DbHealthCheckerOptions
): HealthChecker => {
  const { name, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return async (): Promise<HealthCheckResult> => {
    const startTime = Date.now();

    try {
      // Create a promise that rejects after timeout
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Database health check timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      });

      // Execute SELECT 1 with timeout
      const queryPromise = sql`SELECT 1`.execute(db);

      await Promise.race([queryPromise, timeoutPromise]);

      const latencyMs = Date.now() - startTime;

      return {
        name,
        status: 'healthy',
        latencyMs,
        critical: true,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : 'Unknown database error';

      return {
        name,
        status: 'unhealthy',
        message,
        latencyMs,
        critical: true,
      };
    }
  };
};
