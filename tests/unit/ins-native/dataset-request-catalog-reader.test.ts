/**
 * The catalog check behind POST /api/ins/dataset-requests reads the native INS
 * repository through one bounded session per call (slice 1 commit 5). Its
 * contract is the legacy reader's: every catalog row resolves, loaded or not,
 * and the session is always closed.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  makeInsNativeDatasetCatalogReader,
  type InsDatasetView,
  type InsReadSession,
  type InsRepo,
} from '@/modules/ins-native/index.js';

import { makeFakeRepo } from '../../fixtures/ins-native/fake-repo.js';

const session = (
  repo: Awaited<ReturnType<InsReadSession['getRepo']>>,
  closed: string[]
): InsReadSession => ({
  getRepo: async () => repo,
  close: async () => {
    closed.push('closed');
    return ok(undefined);
  },
});

describe('native INS dataset catalog reader', () => {
  it('resolves a catalog dataset whose facts are not loaded, and closes the session', async () => {
    const closed: string[] = [];
    // Only `getDataset` matters here; a not-loaded catalog row is a view with
    // `yearRange: null`, which the reader must still count as existing.
    const repo: InsRepo = {
      ...makeFakeRepo(),
      getDataset: async (code) =>
        ok(code === 'POP107D' ? ({ code, yearRange: null } as unknown as InsDatasetView) : null),
    };
    const reader = makeInsNativeDatasetCatalogReader(() => session(ok(repo), closed));
    expect((await reader.datasetExists('POP107D'))._unsafeUnwrap()).toBe(true);
    expect((await reader.datasetExists('NOPE'))._unsafeUnwrap()).toBe(false);
    expect(closed).toHaveLength(2);
  });

  it('maps a failed session to a 5xx-class request error and still closes it', async () => {
    const closed: string[] = [];
    const reader = makeInsNativeDatasetCatalogReader(() =>
      session(err({ type: 'Timeout', message: 'slow' }), closed)
    );
    const result = await reader.datasetExists('POP107D');
    expect(result._unsafeUnwrapErr().type).toBe('TimeoutError');
    expect(closed).toHaveLength(1);
  });
});
