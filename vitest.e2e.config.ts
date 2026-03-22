import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'build'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    sequence: {
      concurrent: false,
    },
    setupFiles: ['./tests/e2e/setup.ts'],
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
