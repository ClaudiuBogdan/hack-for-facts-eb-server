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
    alias: [
      // `graphql` ships CJS (`main`) and ESM (`module`) builds without an
      // `exports` map. Node resolves both `import` and `require` to the CJS
      // build, so the running server has one instance; Vite prefers `module`
      // for our ESM sources while mercurius `require`s the CJS build, giving
      // two instances under vitest. Cross-instance `instanceof` checks then
      // fail ("Cannot use GraphQLNonNull from another module or realm"), which
      // masked every production-redaction assertion as a spurious validation
      // error. Pin the bare specifier to the CJS entry so tests execute the
      // same graph the server does (tests/unit/infra/graphql-single-instance.test.ts).
      {
        find: /^graphql$/u,
        replacement: path.resolve(__dirname, './node_modules/graphql/index.js'),
      },
      { find: '@/infra', replacement: path.resolve(__dirname, './src/infra') },
      { find: '@/common', replacement: path.resolve(__dirname, './src/common') },
      { find: '@/modules', replacement: path.resolve(__dirname, './src/modules') },
      { find: '@/tests', replacement: path.resolve(__dirname, './tests') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
});
