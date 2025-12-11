/**
 * Unit tests for getBudgetSector use case.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getBudgetSector } from '@/modules/budget-sector/core/usecases/get-budget-sector.js';

import type { BudgetSectorRepository } from '@/modules/budget-sector/core/ports.js';
import type { BudgetSector } from '@/modules/budget-sector/core/types.js';

/**
 * Creates a fake repository with the given sectors.
 */
const makeFakeRepo = (sectors: BudgetSector[]): BudgetSectorRepository => ({
  findById: async (id: number) => {
    const sector = sectors.find((s) => s.sector_id === id);
    return ok(sector ?? null);
  },
  list: async () =>
    ok({ nodes: [], pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false } }),
});

describe('getBudgetSector', () => {
  describe('successful lookup', () => {
    it('returns sector when found', async () => {
      const repo = makeFakeRepo([{ sector_id: 1, sector_description: 'Buget local' }]);
      const result = await getBudgetSector({ budgetSectorRepo: repo }, 1);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({
        sector_id: 1,
        sector_description: 'Buget local',
      });
    });

    it('returns correct sector when multiple exist', async () => {
      const repo = makeFakeRepo([
        { sector_id: 1, sector_description: 'Buget local' },
        { sector_id: 2, sector_description: 'Buget de stat' },
        { sector_id: 3, sector_description: 'Buget asigurari sociale' },
      ]);

      const result = await getBudgetSector({ budgetSectorRepo: repo }, 2);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.sector_description).toBe('Buget de stat');
    });
  });

  describe('not found', () => {
    it('returns null when not found', async () => {
      const repo = makeFakeRepo([]);
      const result = await getBudgetSector({ budgetSectorRepo: repo }, 999);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns null for ID not in list', async () => {
      const repo = makeFakeRepo([{ sector_id: 1, sector_description: 'Buget local' }]);
      const result = await getBudgetSector({ budgetSectorRepo: repo }, 42);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe('error handling', () => {
    it('propagates repository errors', async () => {
      const errorRepo: BudgetSectorRepository = {
        findById: async () =>
          err({ type: 'DatabaseError', message: 'Connection failed', retryable: true }),
        list: async () =>
          err({ type: 'DatabaseError', message: 'Connection failed', retryable: true }),
      };

      const result = await getBudgetSector({ budgetSectorRepo: errorRepo }, 1);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
      expect(result._unsafeUnwrapErr().message).toBe('Connection failed');
    });
  });
});
