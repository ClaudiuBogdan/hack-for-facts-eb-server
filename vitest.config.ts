import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `*.test.ts` only. The two `*.spec.ts` files under `src/` are
    // `CollectionFilterSpec` *declarations*, not vitest suites, and vitest fails
    // them with "No test suite found" — which made this pipeline red, so
    // `test:e2e` and `build` never ran behind it. No `*.spec.ts` anywhere in the
    // repo declares a suite.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'build', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        '**/index.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    setupFiles: ['./tests/setup.ts'],
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
