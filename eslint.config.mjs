import eslint from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';
import { flatConfigs as importPluginFlatConfigs } from 'eslint-plugin-import-x';
import promise from 'eslint-plugin-promise';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

export default defineConfig(
  // ========================================================================
  // Base Setup & Global Ignores
  // ========================================================================
  {
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      '**/*.d.ts',
      '.git/**',
      '.opencode/**',
      'old_code_repositories',
      'tests/golden-master/snapshots/**',
    ],
  },

  // ========================================================================
  // Recommended Configs (Extends)
  // ========================================================================
  eslint.configs.recommended,

  // UPGRADE: Use TypeChecked versions.
  // This enables rules that understand your objects/promises.
  ...tseslintConfigs.strictTypeChecked,
  ...tseslintConfigs.stylisticTypeChecked,

  importPluginFlatConfigs.recommended,
  importPluginFlatConfigs.typescript,
  promise.configs['flat/recommended'],

  // ========================================================================
  // Plugin Configuration & Architecture Definitions
  // ========================================================================
  {
    plugins: {
      boundaries,
      unicorn,
      'eslint-comments': comments,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true, // NEW: Faster and easier than pointing to tsconfig
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
      // Architecture Boundaries (Same as before)
      'boundaries/elements': [
        { type: 'core', pattern: 'src/modules/*/core/**/*', mode: 'file' },
        { type: 'shell', pattern: 'src/modules/*/shell/**/*', mode: 'file' },
        { type: 'infra', pattern: 'src/infra/**/*', mode: 'file' },
        { type: 'common', pattern: 'src/common/**/*', mode: 'file' },
        { type: 'app', pattern: ['src/app.ts', 'src/api.ts'], mode: 'file' },
      ],
    },
    rules: {
      // ====================================================================
      // A. ASYNC SAFETY & RELIABILITY (New Additions)
      // ====================================================================

      // Mandatory for Backend: Prevents "fire and forget" errors
      '@typescript-eslint/no-floating-promises': 'error',

      // Prevents passing async functions to places that expect sync (like Array.forEach)
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],

      // Enforce `await` if a function is marked async (removes dead async code)
      '@typescript-eslint/require-await': 'error',

      // ====================================================================
      // B. DATA SAFETY (Financial Precision)
      // ====================================================================

      // STRICT BOOLEANS: Prevents `0` or `""` from being falsey.
      // In a budget app, 0 is a valid number. You must write `if (amount !== 0)`
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
        },
      ],

      // Force explicit equality checks (no ==)
      eqeqeq: ['error', 'smart'],

      // ====================================================================
      // C. CODING STANDARDS & MAINTAINABILITY
      // ====================================================================

      // Force comments when disabling ESLint rules
      'eslint-comments/require-description': 'error',
      'eslint-comments/no-unlimited-disable': 'error',

      // Naming Conventions (Kebab files, Camel code)
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'PascalCase', 'UPPER_CASE'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        // Allow snake_case for type properties (GraphQL schema, DB columns)
        // Allow PascalCase for Fastify route generics (Reply, Body, Params, etc.)
        { selector: 'typeProperty', format: ['camelCase', 'snake_case', 'PascalCase'] },
        { selector: 'objectLiteralProperty', format: null },
      ],

      // Import Ordering
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'object',
            'type',
          ],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/no-cycle': 'error',
      'import-x/no-named-as-default-member': 'off',

      // Unused Vars
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // ====================================================================
      // D. ARCHITECTURAL BOUNDARIES (Transparenta Spec)
      // ====================================================================

      // "No Float" Rule
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Floats are forbidden. Use decimal.js or integer math.',
        },
      ],

      // Module Boundaries + Pure Core Dependencies (v6 object-based selectors)
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          rules: [
            // Element-type boundaries
            {
              from: { type: 'core' },
              allow: { to: { type: 'common' } },
              disallow: { to: { type: ['shell', 'infra', 'app'] } },
              message: 'Core must be pure.',
            },
            {
              from: { type: 'shell' },
              allow: { to: { type: ['core', 'common', 'infra'] } },
              message: 'Shell orchestrates Core/Infra.',
            },
            {
              from: { type: 'infra' },
              allow: { to: { type: 'common' } },
              disallow: { to: { type: ['core', 'shell'] } },
              message: 'Infra must be generic.',
            },
            // External dependency boundaries for core
            {
              from: { type: 'core' },
              disallow: [
                { to: { origin: ['external', 'core'] }, dependency: { module: 'fastify' } },
                { to: { origin: ['external', 'core'] }, dependency: { module: 'kysely' } },
                { to: { origin: ['external', 'core'] }, dependency: { module: 'pg' } },
                { to: { origin: ['external', 'core'] }, dependency: { module: 'redis' } },
                { to: { origin: ['external', 'core'] }, dependency: { module: 'bullmq' } },
                { to: { origin: ['external', 'core'] }, dependency: { module: 'axios' } },
                { to: { origin: ['external', 'core'] }, dependency: { module: 'fs' } },
                { to: { origin: ['external', 'core'] }, dependency: { module: 'http' } },
                {
                  to: { origin: ['external', 'core'] },
                  dependency: { module: '@modelcontextprotocol/sdk' },
                },
              ],
              message: 'Core modules must not import I/O libraries.',
            },
          ],
        },
      ],

      // Safe Parsing
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message: 'Use a safe parsing utility (Result-based) instead of JSON.parse.',
        },
      ],
    },
  },

  // ========================================================================
  // Destructive user-data anonymizer guard
  // ========================================================================
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/modules/clerk-webhooks/index.js',
              importNames: [
                'makeUserDataAnonymizer',
                'UserDataAnonymizer',
                'UserDataAnonymizationInput',
                'UserDataAnonymizationSummary',
              ],
              message:
                'The deleted-user anonymizer is destructive. Import it only from the approved composition/handler files.',
            },
            {
              name: '../modules/clerk-webhooks/index.js',
              importNames: [
                'makeUserDataAnonymizer',
                'UserDataAnonymizer',
                'UserDataAnonymizationInput',
                'UserDataAnonymizationSummary',
              ],
              message:
                'The deleted-user anonymizer is destructive. Import it only from the approved composition/handler files.',
            },
          ],
          patterns: [
            {
              group: [
                '@/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.js',
                '**/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.js',
                './anonymization/user-data-anonymizer.js',
                '../anonymization/user-data-anonymizer.js',
              ],
              message:
                'The deleted-user anonymizer is destructive. Import it only from the approved composition/handler files.',
            },
          ],
        },
      ],
    },
  },

  {
    files: [
      'src/app/build-app.ts',
      'src/modules/clerk-webhooks/shell/anonymization/admin-email-notifier.ts',
      'src/modules/clerk-webhooks/shell/handlers/user-deleted-anonymization-handler.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // ========================================================================
  // SQL Safety Rules - Ban sql.raw() in repositories
  // ========================================================================
  {
    files: ['src/modules/*/shell/repo/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message: 'Use a safe parsing utility (Result-based) instead of JSON.parse.',
        },
        {
          selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
          message: 'sql.raw() is banned in repositories due to SQL injection risk.',
        },
      ],
    },
  },

  // ========================================================================
  // Overrides & Exceptions
  // ========================================================================

  // A. CORE LOGIC (Pure Functions)
  {
    files: ['src/modules/*/core/**/*.ts'],
    rules: {
      // Enforce Result Pattern (No throwing)
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ThrowStatement',
          message: 'Do not throw exceptions in Core logic. Use Result<T, E>.',
        },
      ],
    },
  },

  // B. REPOSITORIES (DB Layer)
  {
    files: ['src/modules/*/shell/repo.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'fastify', message: 'Repos should not depend on HTTP types.' }] },
      ],
    },
  },

  // C. API HANDLERS (Shell/API)
  {
    // API handlers often need to be async to satisfy Fastify types, even if they strictly await services
    files: ['src/modules/*/shell/api.*.ts', 'src/app.ts', 'src/modules/*/shell/rest/routes.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },

  // D. TEST FILES (Unit/Integration)
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Allow magic numbers in tests
      'no-magic-numbers': 'off',
    },
  },

  // E. CONFIG FILES (No type checking needed)
  {
    files: ['*.config.{js,ts,mjs,cjs}'],
    ...tseslintConfigs.disableTypeChecked,
  },

  // F. REPOSITORY UTILITY SCRIPTS (Node-only, outside TS project service)
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    ...tseslintConfigs.disableTypeChecked,
  },

  // ========================================================================
  // Prettier (Must be last)
  // ========================================================================
  prettierConfig
);
