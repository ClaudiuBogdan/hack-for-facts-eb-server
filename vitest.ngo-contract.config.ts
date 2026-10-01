import { existsSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

const dataRoot = path.resolve(process.env.NGO_DATA_REPO ?? '../hack-for-facts-eb-scrapper');
if (
  !process.env.TEST_DATABASE_URL ||
  !existsSync(path.join(dataRoot, 'src/sources/ngos/prod/rnong-keyed-reads.fixture.ts'))
)
  throw new Error(
    'NGO contract tests require TEST_DATABASE_URL (disposable PG18) and NGO_DATA_REPO with the reviewed migrations installed.'
  );
if (process.env.TEST_DATABASE_DISPOSABLE_SERVER === '1')
  throw new Error(
    'NGO contract requires per-fixture database cleanup; unset TEST_DATABASE_DISPOSABLE_SERVER.'
  );
export default defineConfig({
  test: {
    include: ['tests/ngo-contract/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 180000,
    maxWorkers: 1,
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: /^graphql$/u, replacement: path.resolve('node_modules/graphql/index.js') },
      { find: '@ngo-data', replacement: path.join(dataRoot, 'src/sources/ngos/prod') },
      { find: '@/db/prod-migrations', replacement: path.join(dataRoot, 'src/db/prod-migrations') },
      { find: '@/extraction-kit', replacement: path.join(dataRoot, 'src/extraction-kit') },
      { find: '@', replacement: path.resolve('src') },
    ],
  },
});
