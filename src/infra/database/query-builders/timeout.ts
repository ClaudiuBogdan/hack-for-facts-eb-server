/**
 * Statement Timeout Helper
 *
 * Provides a safe way to set PostgreSQL statement timeouts without using sql.raw()
 * in repository code.
 *
 * SECURITY: The timeout value is validated to be a positive integer.
 * This prevents any SQL injection through the timeout parameter.
 */

import { sql, type Kysely } from 'kysely';

// ============================================================================
// Constants
// ============================================================================

/** Default query timeout in milliseconds (30 seconds) */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/** Maximum allowed timeout in milliseconds (5 minutes) */
export const MAX_QUERY_TIMEOUT_MS = 300_000;

/** Minimum allowed timeout in milliseconds (1 second) */
export const MIN_QUERY_TIMEOUT_MS = 1_000;

// ============================================================================
// Timeout Helper
// ============================================================================

/**
 * Sets the statement timeout for the current transaction/session.
 *
 * This is a safe wrapper around `SET LOCAL statement_timeout` that:
 * 1. Validates the timeout is a positive integer within bounds
 * 2. Encapsulates the sql.raw() usage in a controlled location
 *
 * @param db - Kysely database instance
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @throws Error if timeout is invalid
 *
 * @example
 * ```typescript
 * // In repository code:
 * await setStatementTimeout(this.db, 30_000);
 * // ... run query ...
 * ```
 */
export async function setStatementTimeout<DB>(
  db: Kysely<DB>,
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS
): Promise<void> {
  // Validate timeout is a safe integer
  if (!Number.isInteger(timeoutMs)) {
    throw new Error(`Statement timeout must be an integer, got: ${String(timeoutMs)}`);
  }

  if (timeoutMs < MIN_QUERY_TIMEOUT_MS) {
    throw new Error(
      `Statement timeout must be at least ${String(MIN_QUERY_TIMEOUT_MS)}ms, got: ${String(timeoutMs)}`
    );
  }

  if (timeoutMs > MAX_QUERY_TIMEOUT_MS) {
    throw new Error(
      `Statement timeout must be at most ${String(MAX_QUERY_TIMEOUT_MS)}ms, got: ${String(timeoutMs)}`
    );
  }

  // SECURITY: We use sql.raw() here because SET LOCAL doesn't support parameterized values.
  // The timeout value is validated above to be a safe integer, so this is secure.

  await sql.raw(`SET LOCAL statement_timeout = ${String(timeoutMs)}`).execute(db);
}

/**
 * Executes a function with a statement timeout set.
 *
 * This is useful for wrapping repository operations that need timeouts.
 * The timeout is set before the operation and applies to all queries within.
 *
 * @param db - Kysely database instance
 * @param timeoutMs - Timeout in milliseconds
 * @param fn - Function to execute with the timeout
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * const result = await withTimeout(db, 30_000, async () => {
 *   return await db.selectFrom('entities').selectAll().execute();
 * });
 * ```
 */
export async function withTimeout<DB, T>(
  db: Kysely<DB>,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  await setStatementTimeout(db, timeoutMs);
  return fn();
}
