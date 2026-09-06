import { err, ok } from 'neverthrow';
import { describe, it, expect } from 'vitest';

import { legacyDecimal } from '@/modules/budget/core/legacy-analytics/decimal.js';
import {
  budgetMapValues,
  type BudgetMapDeps,
} from '@/modules/budget/core/legacy-analytics/map-usecase.js';

import type { BudgetMapYear } from '@/modules/budget/core/legacy-analytics/map-types.js';
import type { LegacyAnalyticsFilter } from '@/modules/budget/core/legacy-analytics/types.js';

const filter = (over: Partial<LegacyAnalyticsFilter> = {}): LegacyAnalyticsFilter => ({
  account_category: 'ch',
  report_period: { type: 'YEAR', selection: { interval: { start: '2023', end: '2024' } } },
  ...over,
});
const row = (year: number, amount: string, code = 'CJ'): BudgetMapYear => ({
  territoryCode: code,
  year,
  nominalAmount: amount,
  observationCount: '2',
  territoryIds: [1, 2],
  coverage: 'mapped',
});
const deps = (rows: readonly BudgetMapYear[]): BudgetMapDeps => ({
  repo: { yearlyAmounts: () => Promise.resolve(ok(rows)) },
  factors: { yearly: () => Promise.resolve(ok(null)) },
  population: { annualUnions: () => Promise.resolve(ok([])) },
});

describe('annual native map normalization', () => {
  it('divides each year by its eligible population before adding years', async () => {
    const d = deps([row(2023, '1000'), row(2024, '1000')]);
    d.population.annualUnions = async (rows) => {
      expect(rows.map((r) => r.territoryIds)).toEqual([
        [1, 2],
        [1, 2],
      ]);
      return ok([
        { territoryCode: 'CJ', year: 2023, population: '100' },
        { territoryCode: 'CJ', year: 2024, population: '200' },
      ]);
    };
    const r = (
      await budgetMapValues(d, {
        filter: filter({ normalization: 'per_capita' }),
        granularity: 'County',
      })
    )._unsafeUnwrap();
    expect(r.values).toEqual([
      { territoryCode: 'CJ', value: '15', status: 'available', missingYears: [] },
    ]);
    expect(r.unit).toBe('RON/capita');
  });
  it('does not produce partial interval totals when population coverage is missing', async () => {
    const d = deps([row(2023, '1000'), row(2024, '1000')]);
    d.population.annualUnions = () =>
      Promise.resolve(ok([{ territoryCode: 'CJ', year: 2023, population: '100' }]));
    const r = (
      await budgetMapValues(d, {
        filter: filter({ normalization: 'per_capita' }),
        granularity: 'County',
      })
    )._unsafeUnwrap();
    expect(r.values[0]).toEqual({
      territoryCode: 'CJ',
      value: null,
      status: 'unavailable',
      missingYears: [2024],
    });
  });
  it('uses each years exact CPI level and exchange rate before summation', async () => {
    const d = deps([row(2023, '1000'), row(2024, '1000')]);
    d.factors.yearly = (kind) =>
      Promise.resolve(
        ok(
          new Map(
            kind === 'cpi_index'
              ? [
                  [2023, legacyDecimal(100)],
                  [2024, legacyDecimal(110)],
                ]
              : [
                  [2023, legacyDecimal(4)],
                  [2024, legacyDecimal(5)],
                ]
          )
        )
      );
    const r = (
      await budgetMapValues(d, {
        filter: filter({ currency: 'EUR', inflation_adjusted: true }),
        granularity: 'County',
      })
    )._unsafeUnwrap();
    expect(r.values[0]?.value).toBe('475');
    expect(r.unit).toBe('EUR (real 2024)');
  });
  it('labels exact-year factor gaps and propagates corrupt factor-source failures', async () => {
    const d = deps([row(2023, '1000'), row(2024, '1000')]);
    d.factors.yearly = () => Promise.resolve(ok(new Map([[2023, legacyDecimal(5)]])));
    const r = (
      await budgetMapValues(d, { filter: filter({ currency: 'EUR' }), granularity: 'County' })
    )._unsafeUnwrap();
    expect(r.values[0]?.missingYears).toEqual([2024]);
    expect(r.values[0]?.value).toBeNull();
    d.factors.yearly = () =>
      Promise.resolve(err({ type: 'ServiceUnavailable', message: 'Manifest mismatch' }));
    expect(
      (
        await budgetMapValues(d, { filter: filter({ currency: 'EUR' }), granularity: 'County' })
      ).isErr()
    ).toBe(true);
  });
  it('preserves decimals beyond floating-point precision and valid zero', async () => {
    const r = (
      await budgetMapValues(
        deps([row(2023, '9007199254740993.01'), row(2024, '0.02'), row(2023, '0', 'IS')]),
        { filter: filter(), granularity: 'County' }
      )
    )._unsafeUnwrap();
    expect(r.values.map((v) => v.value)).toEqual(['9007199254740993.03', '0']);
  });
  it('applies amount limits to the final territory interval in its normalized unit', async () => {
    // Each yearly total already includes multiple selected institutions. Neither
    // individual contributors nor years are removed by an aggregate bound.
    const d = deps([row(2023, '60000'), row(2024, '60000')]);
    let r = (
      await budgetMapValues(d, {
        filter: filter({ aggregate_min_amount: 100000 }),
        granularity: 'County',
      })
    )._unsafeUnwrap();
    expect(r.values[0]?.value).toBe('120000');
    d.factors.yearly = () =>
      Promise.resolve(
        ok(
          new Map([
            [2023, legacyDecimal(5)],
            [2024, legacyDecimal(5)],
          ])
        )
      );
    r = (
      await budgetMapValues(d, {
        filter: filter({ currency: 'EUR', aggregate_min_amount: 100000 }),
        granularity: 'County',
      })
    )._unsafeUnwrap();
    expect(r.values[0]?.status).toBe('outside_bounds');
  });
  it('retains out-of-view and unresolved amounts for coverage disclosure', async () => {
    const outside: BudgetMapYear = {
      ...row(2023, '10'),
      territoryCode: null,
      coverage: 'outside_view',
    };
    const unresolved: BudgetMapYear = {
      ...row(2023, '20'),
      territoryCode: null,
      territoryIds: [],
      coverage: 'unresolved',
    };
    const r = (
      await budgetMapValues(deps([outside, unresolved]), { filter: filter(), granularity: 'UAT' })
    )._unsafeUnwrap();
    expect(r.values).toEqual([]);
    expect(r.years).toEqual([outside, unresolved]);
  });
  it('rejects invalid source decimal strings before arithmetic', async () => {
    for (const amount of ['NaN', 'Infinity', '']) {
      expect(
        (
          await budgetMapValues(deps([row(2023, amount)]), {
            filter: filter(),
            granularity: 'County',
          })
        ).isErr()
      ).toBe(true);
    }
  });
  it('rejects duplicate territory years and ambiguous population custody', async () => {
    let r = await budgetMapValues(deps([row(2023, '1'), row(2023, '2')]), {
      filter: filter(),
      granularity: 'County',
    });
    expect(r.isErr()).toBe(true);
    const d = deps([row(2023, '1')]);
    d.population.annualUnions = () =>
      Promise.resolve(
        ok([
          { territoryCode: 'CJ', year: 2023, population: '100' },
          { territoryCode: 'CJ', year: 2023, population: '200' },
        ])
      );
    r = await budgetMapValues(d, {
      filter: filter({ normalization: 'per_capita' }),
      granularity: 'County',
    });
    expect(r.isErr()).toBe(true);
  });
});
