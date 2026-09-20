import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import { makeNgoProfileRepo } from '@/modules/ngos/shell/repo/profile-repo.js';
import { makeNgoRegistryRepo } from '@/modules/ngos/shell/repo/registry-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

// A disabled capability must issue no SQL, even if queries could return data.
const executeQuery = vi.fn(() => {
  throw new Error('Unexpected database access');
});
class GuardDriver extends DummyDriver {
  override acquireConnection() {
    return Promise.resolve({
      executeQuery,
      streamQuery: async function* () {
        yield executeQuery();
      },
    });
  }
}
const db = new Kysely<ProdDatabase>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new GuardDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
describe('NGO publication capability', () => {
  it('disables all public operations until the explicit release flag is enabled', async () => {
    const repo = makeNgoRegistryRepo(db, false);
    for (const result of await Promise.all([
      repo.coverage(),
      makeNgoProfileRepo(db, false).overview('4305857'),
      repo.list({ filter: {}, first: 20 }),
      repo.detail('record'),
    ])) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.type).toBe('InvalidInput');
    }
    expect(executeQuery).not.toHaveBeenCalled();
  });
});
