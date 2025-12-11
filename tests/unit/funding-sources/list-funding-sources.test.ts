/**
 * Unit tests for listFundingSources use case.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  MAX_LIMIT,
  type FundingSource,
  type FundingSourceFilter,
} from '@/modules/funding-sources/core/types.js';
import { listFundingSources } from '@/modules/funding-sources/core/usecases/list-funding-sources.js';

import type { FundingSourceRepository } from '@/modules/funding-sources/core/ports.js';

const testSources: FundingSource[] = [
  { source_id: 1, source_description: 'Buget de stat' },
  { source_id: 2, source_description: 'Fonduri externe nerambursabile' },
  { source_id: 3, source_description: 'Venituri proprii' },
  { source_id: 4, source_description: 'Credite externe' },
];

/**
 * Creates a fake repository that simulates filtering and pagination.
 */
const makeFakeRepo = (sources: FundingSource[]): FundingSourceRepository => ({
  findById: async () => ok(null),
  list: async (filter: FundingSourceFilter | undefined, limit: number, offset: number) => {
    let filtered = [...sources];

    // Apply search filter
    if (filter?.search !== undefined && filter.search.trim() !== '') {
      const s = filter.search.toLowerCase();
      filtered = filtered.filter((src) => src.source_description.toLowerCase().includes(s));
    }

    // Apply source_ids filter
    if (filter?.source_ids !== undefined && filter.source_ids.length > 0) {
      const ids = new Set(filter.source_ids);
      filtered = filtered.filter((src) => ids.has(src.source_id));
    }

    // Sort by source_id
    filtered.sort((a, b) => a.source_id - b.source_id);

    const totalCount = filtered.length;
    const nodes = filtered.slice(offset, offset + limit);

    return ok({
      nodes,
      pageInfo: {
        totalCount,
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
      },
    });
  },
});

describe('listFundingSources', () => {
  describe('basic listing', () => {
    it('returns all sources when no filter', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(4);
      expect(conn.pageInfo.totalCount).toBe(4);
    });

    it('returns empty when no sources exist', async () => {
      const repo = makeFakeRepo([]);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(0);
      expect(result._unsafeUnwrap().pageInfo.totalCount).toBe(0);
    });
  });

  describe('pagination', () => {
    it('respects limit', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources({ fundingSourceRepo: repo }, { limit: 2, offset: 0 });

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.pageInfo.hasNextPage).toBe(true);
      expect(conn.pageInfo.hasPreviousPage).toBe(false);
    });

    it('respects offset', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources({ fundingSourceRepo: repo }, { limit: 2, offset: 2 });

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.pageInfo.hasPreviousPage).toBe(true);
    });

    it('clamps negative offset to 0', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { limit: 10, offset: -5 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().pageInfo.hasPreviousPage).toBe(false);
    });

    it('clamps limit to MAX_LIMIT', async () => {
      // Create repo that tracks received limit
      let receivedLimit = 0;
      const repo: FundingSourceRepository = {
        findById: async () => ok(null),
        list: async (_f, limit, _o) => {
          receivedLimit = limit;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listFundingSources({ fundingSourceRepo: repo }, { limit: 999, offset: 0 });
      expect(receivedLimit).toBe(MAX_LIMIT);
    });

    it('clamps negative limit to 1', async () => {
      let receivedLimit = 0;
      const repo: FundingSourceRepository = {
        findById: async () => ok(null),
        list: async (_f, limit, _o) => {
          receivedLimit = limit;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listFundingSources({ fundingSourceRepo: repo }, { limit: -5, offset: 0 });
      expect(receivedLimit).toBe(1);
    });
  });

  describe('filtering', () => {
    it('filters by search term', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { filter: { search: 'externe' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2); // "Fonduri externe" and "Credite externe"
    });

    it('search is case insensitive', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { filter: { search: 'BUGET' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(1);
    });

    it('filters by source_ids', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { filter: { source_ids: [1, 3] }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.nodes.map((n) => n.source_id)).toEqual([1, 3]);
    });

    it('combines search and source_ids filters', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { filter: { search: 'externe', source_ids: [2, 4] }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(2);
    });

    it('empty search is ignored', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { filter: { search: '   ' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(4);
    });

    it('empty source_ids is ignored', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { filter: { source_ids: [] }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(4);
    });

    it('returns empty when search matches nothing', async () => {
      const repo = makeFakeRepo(testSources);
      const result = await listFundingSources(
        { fundingSourceRepo: repo },
        { filter: { search: 'nonexistent' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(0);
      expect(result._unsafeUnwrap().pageInfo.totalCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('propagates repository errors', async () => {
      const errorRepo: FundingSourceRepository = {
        findById: async () => err({ type: 'DatabaseError', message: 'Failed', retryable: true }),
        list: async () => err({ type: 'DatabaseError', message: 'Failed', retryable: true }),
      };

      const result = await listFundingSources(
        { fundingSourceRepo: errorRepo },
        { limit: 10, offset: 0 }
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
    });
  });
});
