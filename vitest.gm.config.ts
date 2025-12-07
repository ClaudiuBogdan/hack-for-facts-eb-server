/**
 * Vitest Configuration for Golden Master E2E Tests
 *
 * This configuration is used exclusively for Golden Master tests that verify
 * GraphQL query outputs against known-good snapshots.
 *
 * Usage:
 *   pnpm test:gm                    # Run Golden Master tests
 *   pnpm test:gm -- --update        # Update snapshots
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

    // Sequential execution - tests share a single DB connection
    sequence: {
      concurrent: false,
    },

    // Setup file for Golden Master tests
    setupFiles: ['./tests/golden-master/setup.ts'],

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
