/**
 * A throwaway PostgreSQL for the e2e suites that prove SQL against a real
 * server: a Testcontainers `postgres:16-alpine` the suite starts and stops
 * itself. Such a container is disposable by construction, so only its database
 * name is fixed; an externally supplied URL stays guarded by the suite. Absent
 * a runtime (no Docker CLI, or a CLI whose daemon Testcontainers cannot reach)
 * the result is `undefined` and the suite decides to skip or, under
 * `TEST_E2E_REQUIRED=1`, to fail. Shared by `search-repo-entities`,
 * `map-owner-deletion` and `normalization-factor-set` (codebase plan §WP3).
 */
import { execSync } from 'node:child_process';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const dockerCliUp = (): boolean => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const startDisposablePostgres = async (
  database: string
): Promise<StartedPostgreSqlContainer | undefined> => {
  if (!dockerCliUp()) return undefined;
  try {
    return await new PostgreSqlContainer('postgres:16-alpine').withDatabase(database).start();
  } catch (error) {
    // The CLI reported a daemon but Testcontainers found no working runtime.
    console.warn(
      `Testcontainers runtime unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
};

/** Run each teardown step even when an earlier one throws; the container is stopped last. */
export const teardownDisposablePostgres = async (
  container: StartedPostgreSqlContainer | undefined,
  ...steps: readonly (() => Promise<unknown> | undefined)[]
): Promise<void> => {
  try {
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn(
          `teardown step failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } finally {
    await container?.stop();
  }
};
