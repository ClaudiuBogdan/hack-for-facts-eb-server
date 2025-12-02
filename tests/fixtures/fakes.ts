/**
 * Test fakes and mocks
 */

import { ok, err, type Result } from 'neverthrow';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type { DatasetRepo, Dataset, DatasetRepoError } from '@/modules/datasets/index.js';

export const makeFakeDatasetRepo = (datasets: Record<string, Dataset> = {}): DatasetRepo => {
  return {
    getById: async (id: string): Promise<Result<Dataset, DatasetRepoError>> => {
      const dataset = datasets[id];
      if (dataset != null) {
        return ok(dataset);
      }
      return err({ type: 'NotFound', message: `Dataset ${id} not found` });
    },
    listAvailable: async () => {
      return ok([]);
    },
  };
};

export const makeFakeBudgetDb = (): BudgetDbClient => {
  // This is a very basic fake.
  // If you need to mock query results, you might need a more sophisticated mock
  // using something like 'kysely-mock' or manually mocking the chainable methods.
  // For now, since we just need it to pass dependency injection checks,
  // we can cast an empty object or a partial mock.
  return {} as unknown as BudgetDbClient;
};
