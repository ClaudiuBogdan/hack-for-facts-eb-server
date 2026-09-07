import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { budgetMapGroupValues } from '@/modules/budget/core/legacy-analytics/map-groups.js';

import type { BudgetMapResult } from '@/modules/budget/core/legacy-analytics/map-types.js';

const source = (): BudgetMapResult => ({
  unit: 'RON/capita',
  populations: [],
  values: ['A', 'B'].map((territoryCode) => ({
    territoryCode,
    value: '10',
    status: 'available',
    missingYears: [],
  })),
  years: [2023, 2024].flatMap((year) =>
    ['A', 'B'].map((territoryCode, i) => ({
      territoryCode,
      year,
      nominalAmount: '1000',
      observationCount: '1',
      territoryIds: [1, i + 2],
      coverage: 'mapped' as const,
    }))
  ),
});
const filter = {
  account_category: 'ch' as const,
  report_period: { type: 'YEAR' as const, selection: { dates: ['2023', '2024'] } },
  normalization: 'per_capita' as const,
};
describe('native financial groups', () => {
  it('normalizes each year against the union of selected anchors', async () => {
    const population = {
      annualUnions: vi.fn().mockResolvedValue(
        ok([
          { territoryCode: 'g', year: 2023, population: '100' },
          { territoryCode: 'g', year: 2024, population: '200' },
        ])
      ),
    };
    const result = await budgetMapGroupValues(
      { factors: { yearly: () => Promise.resolve(ok(null)) }, population },
      { source: source(), filter, groups: [{ key: 'g', members: ['A', 'B'] }] }
    );
    expect(result._unsafeUnwrap()[0]?.value).toBe('30');
    expect(population.annualUnions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ year: 2023, nominalAmount: '2000', territoryIds: [1, 2, 3] }),
      ])
    );
  });
  it.each(['outside_bounds', 'unavailable'] as const)(
    'keeps fixed membership unavailable for a %s member',
    async (status) => {
      const input = source();
      const population = { annualUnions: vi.fn() };
      const result = await budgetMapGroupValues(
        { factors: { yearly: () => Promise.resolve(ok(null)) }, population },
        {
          source: {
            ...input,
            values: [input.values[0]!, { ...input.values[1]!, value: null, status }],
          },
          filter,
          groups: [{ key: 'g', members: ['A', 'B'] }],
        }
      );
      expect(result._unsafeUnwrap()[0]).toMatchObject({
        value: null,
        unavailableReason:
          status === 'outside_bounds' ? 'source_filtered_member' : 'source_unavailable_member',
      });
      expect(population.annualUnions).not.toHaveBeenCalled();
    }
  );
  it.each(['disjoint', 'absent'] as const)(
    'rejects %s annual member coverage rather than shrinking the population union',
    async (coverage) => {
      const input = source();
      const years = input.years.filter((row) =>
        coverage === 'disjoint'
          ? row.territoryCode === 'A'
            ? row.year === 2023
            : row.year === 2024
          : row.year === 2023
      );
      const population = { annualUnions: vi.fn() };
      const result = await budgetMapGroupValues(
        { factors: { yearly: () => Promise.resolve(ok(null)) }, population },
        { source: { ...input, years }, filter, groups: [{ key: 'g', members: ['A', 'B'] }] }
      );
      expect(result._unsafeUnwrap()[0]).toMatchObject({
        value: null,
        missingYears: coverage === 'disjoint' ? [2023, 2024] : [2024],
        unavailableReason: 'source_unavailable_member',
      });
      expect(population.annualUnions).not.toHaveBeenCalled();
    }
  );
  it('never returns a partial multi-year value when the union population is absent', async () => {
    const result = await budgetMapGroupValues(
      {
        factors: { yearly: () => Promise.resolve(ok(null)) },
        population: {
          annualUnions: () =>
            Promise.resolve(ok([{ territoryCode: 'g', year: 2023, population: '100' }])),
        },
      },
      { source: source(), filter, groups: [{ key: 'g', members: ['A', 'B'] }] }
    );
    expect(result._unsafeUnwrap()[0]).toMatchObject({
      value: null,
      missingYears: [2024],
      unavailableReason: 'normalization_unavailable',
    });
  });
});
