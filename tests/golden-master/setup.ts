/**
 * Golden Master Test Setup
 *
 * This setup file validates the environment configuration before tests run.
 * It ensures either TEST_GM_API_URL or TEST_GM_DATABASE_URL is set.
 */

import { beforeAll, afterAll } from 'vitest';

import { getExecutionMode, closeClient } from './client.js';

// =============================================================================
// Environment Validation
// =============================================================================

beforeAll(() => {
  // Set test environment
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env.TZ = 'UTC';

  // Validate configuration
  try {
    const mode = getExecutionMode();
    console.log(`\n[Golden Master] Execution mode: ${mode.toUpperCase()}`);
    console.log('[Golden Master] Tests will use historical data from 2016-2024\n');
  } catch (error) {
    console.error('\n[Golden Master] Configuration Error:');
    console.error((error as Error).message);
    console.error('\nTo run Golden Master tests, set one of:');
    console.error('  - TEST_GM_API_URL    (for snapshot generation from prod)');
    console.error('  - TEST_GM_DATABASE_URL (for CI/local testing)\n');
    throw error;
  }
});

// =============================================================================
// Cleanup
// =============================================================================

afterAll(async () => {
  await closeClient();
  console.log('\n[Golden Master] Tests completed, resources cleaned up\n');
});
