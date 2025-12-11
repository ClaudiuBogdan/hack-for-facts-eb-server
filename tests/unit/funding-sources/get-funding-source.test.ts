/**
 * Unit tests for getFundingSource use case.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getFundingSource } from '@/modules/funding-sources/core/usecases/get-funding-source.js';

import type { FundingSourceRepository } from '@/modules/funding-sources/core/ports.js';
import type { FundingSource } from '@/modules/funding-sources/core/types.js';

/**
 * Creates a fake repository with the given sources.
 */
const makeFakeRepo = (sources: FundingSource[]): FundingSourceRepository => ({
  findById: async (id: number) => {
    const source = sources.find((s) => s.source_id === id);
    return ok(source ?? null);
  },
  list: async () =>
    ok({ nodes: [], pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false } }),
});

describe('getFundingSource', () => {
  describe('successful lookup', () => {
    it('returns source when found', async () => {
      const repo = makeFakeRepo([{ source_id: 1, source_description: 'Buget de stat' }]);
      const result = await getFundingSource({ fundingSourceRepo: repo }, 1);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({
        source_id: 1,
        source_description: 'Buget de stat',
      });
    });

    it('returns correct source when multiple exist', async () => {
      const repo = makeFakeRepo([
        { source_id: 1, source_description: 'Buget de stat' },
        { source_id: 2, source_description: 'Fonduri externe' },
        { source_id: 3, source_description: 'Venituri proprii' },
      ]);

      const result = await getFundingSource({ fundingSourceRepo: repo }, 2);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.source_description).toBe('Fonduri externe');
    });
  });

  describe('not found', () => {
    it('returns null when not found', async () => {
      const repo = makeFakeRepo([]);
      const result = await getFundingSource({ fundingSourceRepo: repo }, 999);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns null for ID not in list', async () => {
      const repo = makeFakeRepo([{ source_id: 1, source_description: 'Buget de stat' }]);
      const result = await getFundingSource({ fundingSourceRepo: repo }, 42);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe('error handling', () => {
    it('propagates repository errors', async () => {
      const errorRepo: FundingSourceRepository = {
        findById: async () =>
          err({ type: 'DatabaseError', message: 'Connection failed', retryable: true }),
        list: async () =>
          err({ type: 'DatabaseError', message: 'Connection failed', retryable: true }),
      };

      const result = await getFundingSource({ fundingSourceRepo: errorRepo }, 1);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
      expect(result._unsafeUnwrapErr().message).toBe('Connection failed');
    });
  });
});
