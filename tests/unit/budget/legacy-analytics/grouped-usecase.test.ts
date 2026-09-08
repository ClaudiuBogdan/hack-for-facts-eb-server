import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { legacyDecimal } from '@/modules/budget/core/legacy-analytics/decimal.js';
import {
  groupedEntityAnalytics,
  groupedClassificationAnalytics,
  groupedYears,
  type GroupedAnalyticsDeps,
} from '@/modules/budget/core/legacy-analytics/grouped-usecase.js';
import { resolveNormalizationPlan } from '@/modules/budget/core/legacy-analytics/normalize.js';
import { exactYearMoneyMultipliers } from '@/modules/budget/core/legacy-analytics/yearly-multipliers.js';

import type { GroupedQuery } from '@/modules/budget/core/legacy-analytics/grouped-types.js';
import type { LegacyAnalyticsFilter } from '@/modules/budget/core/legacy-analytics/types.js';

const filter = (extra: Partial<LegacyAnalyticsFilter> = {}): LegacyAnalyticsFilter => ({
  account_category: 'ch',
  report_period: { type: 'YEAR', selection: { interval: { start: '2023', end: '2024' } } },
  ...extra,
});
const series = (entries: [number, string][]) =>
  new Map(entries.map(([year, value]) => [year, legacyDecimal(value)]));
const fixture = () => {
  const calls: GroupedQuery[] = [];
  const clamped: unknown[] = [];
  const empty = {
    nodes: [],
    pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
  };
  const deps: GroupedAnalyticsDeps = {
    grouped: {
      entities: (q) => {
        calls.push(q);
        return Promise.resolve(ok(empty));
      },
      classifications: (q) => {
        calls.push(q);
        return Promise.resolve(ok(empty));
      },
    },
    factors: { yearly: () => Promise.resolve(ok(null)) },
    population: { scopedPopulation: () => Promise.resolve(ok(legacyDecimal(100))) },
    onClamped: (info) => clamped.push(info),
  };
  return { deps, calls, clamped };
};

describe('strict yearly monetary multipliers', () => {
  it('normalizes each year with exact CPI and FX before aggregation', () => {
    const result = exactYearMoneyMultipliers(
      resolveNormalizationPlan(filter({ currency: 'EUR', inflation_adjusted: true })),
      {
        cpiIndex: series([
          [2023, '100'],
          [2024, '110'],
        ]),
        fxRate: series([
          [2023, '4'],
          [2024, '5'],
        ]),
      },
      [2023, 2024]
    )._unsafeUnwrap();
    expect(result.get(2023)?.toString()).toBe('0.275');
    expect(result.get(2024)?.toString()).toBe('0.2');
  });
  it('opts into native base-year FX while the compatibility default remains period FX', () => {
    const context = {
      cpiIndex: series([
        [2023, '100'],
        [2024, '110'],
      ]),
      fxRate: series([
        [2023, '4'],
        [2024, '5'],
      ]),
    };
    const realPlan = resolveNormalizationPlan(
      filter({ currency: 'EUR', inflation_adjusted: true })
    );
    const native = exactYearMoneyMultipliers(
      realPlan,
      context,
      [2023, 2024],
      'cpi-base-year'
    )._unsafeUnwrap();
    const legacy = exactYearMoneyMultipliers(realPlan, context, [2023, 2024])._unsafeUnwrap();
    const nominal = exactYearMoneyMultipliers(
      resolveNormalizationPlan(filter({ currency: 'EUR' })),
      context,
      [2023, 2024],
      'cpi-base-year'
    )._unsafeUnwrap();
    const total = (values: ReadonlyMap<number, ReturnType<typeof legacyDecimal>>) =>
      [...values.values()]
        .reduce((sum, value) => sum.plus(value.mul(1000)), legacyDecimal(0))
        .toString();
    expect(total(native)).toBe('420');
    expect(total(legacy)).toBe('475');
    expect(total(nominal)).toBe('450');
  });
  it.each(['0', '-1', 'NaN', 'Infinity'])(
    'rejects invalid FX %s without nominal fallback',
    (value) => {
      expect(
        exactYearMoneyMultipliers(
          resolveNormalizationPlan(filter({ currency: 'EUR' })),
          { fxRate: series([[2023, value]]) },
          [2023]
        ).isErr()
      ).toBe(true);
    }
  );
  it('does not carry forward CPI, GDP or exchange rates', () => {
    for (const [extra, context] of [
      [{ inflation_adjusted: true }, { cpiIndex: series([[2023, '100']]) }],
      [{ currency: 'EUR' as const }, { fxRate: series([[2023, '5']]) }],
      [{ normalization: 'percent_gdp' as const }, { gdp: series([[2023, '1000']]) }],
    ] as const) {
      const result = exactYearMoneyMultipliers(
        resolveNormalizationPlan(filter(extra)),
        context,
        [2023, 2024]
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.message).toContain('2024');
    }
  });
  it('GDP percentage is exclusive even when currency and inflation are requested', () => {
    const result = exactYearMoneyMultipliers(
      resolveNormalizationPlan(
        filter({ normalization: 'percent_gdp', currency: 'EUR', inflation_adjusted: true })
      ),
      { gdp: series([[2023, '2000']]) },
      [2023]
    );
    expect(result._unsafeUnwrap().get(2023)?.toString()).toBe('0.05');
  });
});

describe('grouped analytics request preparation', () => {
  it('rejects a missing required year before any SQL repository call', async () => {
    const { deps, calls } = fixture();
    const result = await groupedEntityAnalytics(
      { ...deps, factors: { yearly: () => Promise.resolve(ok(series([[2023, '100']]))) } },
      { filter: filter({ inflation_adjusted: true }) }
    );
    expect(result.isErr()).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('logs clamping and validates sort instead of silently changing it', async () => {
    const { deps, calls, clamped } = fixture();
    expect((await groupedEntityAnalytics(deps, { filter: filter(), limit: 150000 })).isOk()).toBe(
      true
    );
    expect(calls[0]?.limit).toBe(100000);
    expect(clamped).toEqual([{ requested: 150000, clamp: 100000 }]);
    expect(
      (
        await groupedEntityAnalytics(deps, {
          filter: filter(),
          sort: { by: 'INVALID', order: 'DESC' },
        })
      ).isErr()
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it('requires full coverage when ranking on per-capita even in nominal mode', async () => {
    const { deps, calls } = fixture();
    await groupedEntityAnalytics(deps, {
      filter: filter(),
      sort: { by: 'PER_CAPITA_AMOUNT', order: 'ASC' },
    });
    expect(calls[0]?.requirePopulation).toBe(true);
    expect(calls[0]?.mode).toBe('total');
  });
  it('rejects GDP per-capita sorting before population or SQL reads', async () => {
    const { deps, calls } = fixture();
    const result = await groupedEntityAnalytics(deps, {
      filter: filter({ normalization: 'percent_gdp' }),
      sort: { by: 'PER_CAPITA_AMOUNT', order: 'DESC' },
    });
    expect(result.isErr()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('keeps transitional scope population explicit as a year map', async () => {
    const { deps, calls } = fixture();
    await groupedClassificationAnalytics(deps, {
      filter: filter({ normalization: 'per_capita', entity_cuis: ['111'] }),
    });
    expect(
      [...calls[0]!.scopePopulations!].map(([year, population]) => [year, population.toString()])
    ).toEqual([
      [2023, '100'],
      [2024, '100'],
    ]);
  });
  it('intersects sparse year selection without demanding unused factor years', () => {
    expect(
      groupedYears({
        years: { from: 2020, to: 2025 },
        tupleList: [
          { year: 2023, sub: 1 },
          { year: 2024, sub: 4 },
        ],
      })
    ).toEqual([2023, 2024]);
    expect(groupedYears({ years: { from: 2024, to: 2023 } })).toEqual([]);
  });
});

describe('annual grouped classification coverage', () => {
  it('batches all selected years without reading transitional population', async () => {
    const { deps, calls } = fixture();
    let reads = 0;
    await groupedClassificationAnalytics(
      {
        ...deps,
        population: {
          scopedPopulation: async () => {
            throw new Error('Unexpected static population read');
          },
        },
        annualScopePopulation: async (scope, years) => {
          reads++;
          expect(scope.kind).toBe('country');
          expect(years).toEqual([2023, 2024]);
          return ok(
            series([
              [2023, '100'],
              [2024, '120'],
            ])
          );
        },
      },
      { filter: filter({ normalization: 'per_capita' }) }
    );
    expect(reads).toBe(1);
    expect(calls[0]?.scopePopulations?.get(2023)?.toString()).toBe('100');
    expect(calls[0]?.scopePopulations?.get(2024)?.toString()).toBe('120');
  });
  it.each([undefined, '0', '-1', 'NaN', 'Infinity'])(
    'rejects missing or invalid annual coverage %s before an empty page',
    async (value) => {
      const { deps, calls } = fixture();
      for (const page of [{ limit: 0 }, { offset: 999 }]) {
        const result = await groupedClassificationAnalytics(
          {
            ...deps,
            annualScopePopulation: async () =>
              ok(
                series(
                  value === undefined
                    ? [[2023, '100']]
                    : [
                        [2023, '100'],
                        [2024, value],
                      ]
                )
              ),
          },
          { filter: filter({ normalization: 'per_capita' }), ...page }
        );
        expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      }
      expect(calls).toHaveLength(0);
    }
  );
  it('propagates annual admission errors and does not read population for nominal requests', async () => {
    const { deps, calls } = fixture();
    let reads = 0;
    const native = {
      ...deps,
      annualScopePopulation: async () => {
        reads++;
        return err({ type: 'ServiceUnavailable' as const, message: 'Admission rejected' });
      },
    };
    expect((await groupedClassificationAnalytics(native, { filter: filter() })).isOk()).toBe(true);
    expect(reads).toBe(0);
    expect(
      (
        await groupedClassificationAnalytics(native, {
          filter: filter({ normalization: 'per_capita' }),
        })
      )._unsafeUnwrapErr().message
    ).toBe('Admission rejected');
    expect(calls).toHaveLength(1);
  });
});
