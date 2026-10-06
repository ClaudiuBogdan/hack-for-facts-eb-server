import { existsSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

const dataRoot = path.resolve(
  process.env.PUBLIC_ENTERPRISES_DATA_REPO ?? '../hack-for-facts-eb-scrapper'
);
const readViews = path.join(
  dataRoot,
  'src/db/prod-migrations/20261006T180000__public_enterprises_public_read_views.ts'
);
if (!process.env.TEST_DATABASE_URL || !existsSync(readViews))
  throw new Error(
    'Public-enterprise contract tests require TEST_DATABASE_URL (disposable PG18) and PUBLIC_ENTERPRISES_DATA_REPO with the reviewed public read-view migration installed.'
  );
if (process.env.TEST_DATABASE_DISPOSABLE_SERVER === '1')
  throw new Error(
    'Public-enterprise contract requires per-fixture database cleanup; unset TEST_DATABASE_DISPOSABLE_SERVER.'
  );
export default defineConfig({
  test: {
    include: ['tests/public-enterprises-contract/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 180000,
    maxWorkers: 1,
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: /^graphql$/u, replacement: path.resolve('node_modules/graphql/index.js') },
      // Test-only: the scraper's real migrations and PG fixture, never the server runtime.
      {
        find: '@pe-data/prod-migrations',
        replacement: path.join(dataRoot, 'src/db/prod-migrations'),
      },
      { find: '@pe-data/extraction-kit', replacement: path.join(dataRoot, 'src/extraction-kit') },
      { find: '@', replacement: path.resolve('src') },
    ],
  },
});
