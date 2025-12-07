/**
 * E2E Test Setup
 *
 * This setup file initializes Testcontainers PostgreSQL for E2E tests.
 * E2E tests run against a real database to verify SQL queries, data integrity,
 * and full system behavior.
 *
 * Requirements:
 *   - Docker Desktop must be running
 *   - Sufficient disk space for PostgreSQL container image
 *
 * Usage:
 *   pnpm test:e2e
 *
 * Note: E2E tests are slow (~5-10s startup) and require Docker.
 * Use sparingly for critical paths and repository implementations.
 */

import { execSync } from 'node:child_process';

import { beforeAll, afterAll } from 'vitest';

import { setupTestDatabase, teardownTestDatabase } from '../infra/test-db.js';

/**
 * Check if Docker daemon is running and accessible.
 * Returns true if Docker is available, false otherwise.
 */
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Exported so tests can check Docker availability */
export let dockerAvailable = false;

beforeAll(async () => {
  console.log('Checking Docker availability...');

  if (!isDockerAvailable()) {
    console.warn('\n' + '='.repeat(70));
    console.warn('WARNING: Docker is not available - E2E tests will be skipped');
    console.warn('='.repeat(70));
    console.warn('\nE2E tests require Docker Desktop to be running.');
    console.warn('\nTo run E2E tests:');
    console.warn('  1. Open Docker Desktop application');
    console.warn('  2. Wait for it to fully start (check the whale icon in menu bar)');
    console.warn('  3. Run `docker ps` to verify connectivity');
    console.warn('  4. Re-run the tests with `pnpm test:e2e`');
    console.warn('\n' + '='.repeat(70) + '\n');
    // Don't throw - let tests handle the skip
    return;
  }

  dockerAvailable = true;
  console.log('Docker is available. Starting E2E test environment...');
  await setupTestDatabase();
  console.log('E2E test environment ready.');
}, 60_000); // 60s timeout for container startup

afterAll(async () => {
  if (!dockerAvailable) {
    return;
  }

  console.log('Tearing down E2E test environment...');
  await teardownTestDatabase();
  console.log('E2E test environment cleaned up.');
});
