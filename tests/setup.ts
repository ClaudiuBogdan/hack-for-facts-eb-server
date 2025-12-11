/**
 * Global test setup file
 * Runs before all tests
 */

import { beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  // Set test environment variables
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
});

afterAll(() => {
  // Cleanup after all tests
});
