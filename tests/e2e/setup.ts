/**
 * E2E Test Setup
 *
 * This setup file initializes Testcontainers PostgreSQL for E2E tests.
 * E2E tests run against a real database to verify SQL queries, data integrity,
 * and full system behavior.
 *
 * Usage:
 *   pnpm test:e2e
 *
 * Note: E2E tests are slow (~5-10s startup) and require Docker.
 * Use sparingly for critical paths and repository implementations.
 */

import { beforeAll, afterAll } from 'vitest';

import { setupTestDatabase, teardownTestDatabase } from '../infra/test-db.js';

beforeAll(async () => {
  console.log('Starting E2E test environment...');
  await setupTestDatabase();
  console.log('E2E test environment ready.');
}, 60_000); // 60s timeout for container startup

afterAll(async () => {
  console.log('Tearing down E2E test environment...');
  await teardownTestDatabase();
  console.log('E2E test environment cleaned up.');
});
