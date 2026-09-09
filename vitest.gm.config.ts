/**
 * Vitest Configuration for Golden Master E2E Tests
 *
 * Golden Master tests against a running kernel endpoint (/api/v1/graphql):
 * the client-document cutover replay (TEST_GM_BASELINE_URL = a preserved
 * legacy /graphql) and the kernel replay of the legacy executionAnalytics
 * snapshots. The 12 legacy-schema snapshot specs were deleted in slice 1
 * commit 6 (2026-09-09) with the legacy endpoint.
 *
 * Usage:
 *   pnpm test:gm                    # Kernel replay specs (snapshot mode)
 *   pnpm test:gm -- --update        # Update snapshots
 *   pnpm test:gm:cutover            # Baseline legacy /graphql vs target /api/v1/graphql
 */

import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/golden-master/**/*.gm.test.ts'],
    exclude: ['node_modules', 'dist'],

    // Longer timeouts for database operations
    testTimeout: 30_000, // 30s per test
    hookTimeout: 60_000, // 60s for setup/teardown

    // Sequential execution - the cutover reconciliation reads one planned.json per run
    sequence: {
      concurrent: false,
    },

    // Setup file for Golden Master tests
    setupFiles: ['./tests/golden-master/setup.ts'],

    // One run id for the whole run + the cutover summary in teardown
    globalSetup: ['./tests/golden-master/global-setup.ts'],

    // Snapshot configuration
    snapshotFormat: {
      escapeString: false,
      printBasicPrototype: false,
    },

    // Verbose output for debugging
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/infra': path.resolve(__dirname, './src/infra'),
      '@/common': path.resolve(__dirname, './src/common'),
      '@/modules': path.resolve(__dirname, './src/modules'),
      '@/tests': path.resolve(__dirname, './tests'),
    },
  },
});
