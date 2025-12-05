/**
 * Unit tests for listBudgetSectors use case.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  MAX_LIMIT,
  type BudgetSector,
  type BudgetSectorFilter,
} from '@/modules/budget-sector/core/types.js';
import { listBudgetSectors } from '@/modules/budget-sector/core/usecases/list-budget-sectors.js';

import type { BudgetSectorRepository } from '@/modules/budget-sector/core/ports.js';

const testSectors: BudgetSector[] = [
  { sector_id: 1, sector_description: 'Buget local' },
  { sector_id: 2, sector_description: 'Buget de stat' },
  { sector_id: 3, sector_description: 'Buget asigurari sociale' },
  { sector_id: 4, sector_description: 'Fonduri externe' },
];

/**
 * Creates a fake repository that simulates filtering and pagination.
 */
const makeFakeRepo = (sectors: BudgetSector[]): BudgetSectorRepository => ({
  findById: async () => ok(null),
  list: async (filter: BudgetSectorFilter | undefined, limit: number, offset: number) => {
    let filtered = [...sectors];

    // Apply search filter
    if (filter?.search !== undefined && filter.search.trim() !== '') {
      const s = filter.search.toLowerCase();
      filtered = filtered.filter((sec) => sec.sector_description.toLowerCase().includes(s));
    }

    // Apply sector_ids filter
    if (filter?.sector_ids !== undefined && filter.sector_ids.length > 0) {
      const ids = new Set(filter.sector_ids);
      filtered = filtered.filter((sec) => ids.has(sec.sector_id));
    }

    // Sort by sector_id
    filtered.sort((a, b) => a.sector_id - b.sector_id);

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

describe('listBudgetSectors', () => {
  describe('basic listing', () => {
    it('returns all sectors when no filter', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors({ budgetSectorRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(4);
      expect(conn.pageInfo.totalCount).toBe(4);
    });

    it('returns empty when no sectors exist', async () => {
      const repo = makeFakeRepo([]);
      const result = await listBudgetSectors({ budgetSectorRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(0);
      expect(result._unsafeUnwrap().pageInfo.totalCount).toBe(0);
    });
  });

  describe('pagination', () => {
    it('respects limit', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors({ budgetSectorRepo: repo }, { limit: 2, offset: 0 });

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.pageInfo.hasNextPage).toBe(true);
      expect(conn.pageInfo.hasPreviousPage).toBe(false);
    });

    it('respects offset', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors({ budgetSectorRepo: repo }, { limit: 2, offset: 2 });

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.pageInfo.hasPreviousPage).toBe(true);
    });

    it('clamps negative offset to 0', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors({ budgetSectorRepo: repo }, { limit: 10, offset: -5 });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().pageInfo.hasPreviousPage).toBe(false);
    });

    it('clamps limit to MAX_LIMIT', async () => {
      // Create repo that tracks received limit
      let receivedLimit = 0;
      const repo: BudgetSectorRepository = {
        findById: async () => ok(null),
        list: async (_f, limit, _o) => {
          receivedLimit = limit;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listBudgetSectors({ budgetSectorRepo: repo }, { limit: 999, offset: 0 });
      expect(receivedLimit).toBe(MAX_LIMIT);
    });

    it('clamps negative limit to 1', async () => {
      let receivedLimit = 0;
      const repo: BudgetSectorRepository = {
        findById: async () => ok(null),
        list: async (_f, limit, _o) => {
          receivedLimit = limit;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listBudgetSectors({ budgetSectorRepo: repo }, { limit: -5, offset: 0 });
      expect(receivedLimit).toBe(1);
    });
  });

  describe('filtering', () => {
    it('filters by search term', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors(
        { budgetSectorRepo: repo },
        { filter: { search: 'local' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(1);
      expect(conn.nodes[0]?.sector_description).toBe('Buget local');
    });

    it('search is case insensitive', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors(
        { budgetSectorRepo: repo },
        { filter: { search: 'LOCAL' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(1);
    });

    it('filters by sector_ids', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors(
        { budgetSectorRepo: repo },
        { filter: { sector_ids: [1, 3] }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.nodes.map((n) => n.sector_id)).toEqual([1, 3]);
    });

    it('combines search and sector_ids filters', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors(
        { budgetSectorRepo: repo },
        { filter: { search: 'buget', sector_ids: [1, 2] }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(2);
    });

    it('empty search is ignored', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors(
        { budgetSectorRepo: repo },
        { filter: { search: '   ' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(4);
    });

    it('empty sector_ids is ignored', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors(
        { budgetSectorRepo: repo },
        { filter: { sector_ids: [] }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(4);
    });

    it('returns empty when search matches nothing', async () => {
      const repo = makeFakeRepo(testSectors);
      const result = await listBudgetSectors(
        { budgetSectorRepo: repo },
        { filter: { search: 'nonexistent' }, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(0);
      expect(result._unsafeUnwrap().pageInfo.totalCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('propagates repository errors', async () => {
      const errorRepo: BudgetSectorRepository = {
        findById: async () => err({ type: 'DatabaseError', message: 'Failed', retryable: true }),
        list: async () => err({ type: 'DatabaseError', message: 'Failed', retryable: true }),
      };

      const result = await listBudgetSectors(
        { budgetSectorRepo: errorRepo },
        { limit: 10, offset: 0 }
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
    });
  });
});
