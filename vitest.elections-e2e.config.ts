import { defineConfig } from 'vitest/config';

import base from './vitest.config.js';

/**
 * The Elections real-DDL proof only: its one file, against the EXTERNAL
 * primary-owned fixture it validates (no container, no shared e2e setup).
 * Inherits the main aliases, including the single-instance `graphql` pin.
 */
export default defineConfig({
  resolve: base.resolve,
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/elections-catalog.test.ts'],
    exclude: [],
    setupFiles: [],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
