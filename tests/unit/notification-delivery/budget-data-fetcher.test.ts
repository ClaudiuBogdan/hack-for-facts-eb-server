import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { createDatabaseError } from '@/modules/notification-delivery/core/errors.js';
import {
  makeBudgetDataFetcher,
  toDeliveryError,
} from '@/modules/notification-delivery/shell/data/budget-data-fetcher.js';

import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { ClassificationPeriodData } from '@/modules/aggregated-line-items/index.js';
import type { NormalizationFactors } from '@/modules/normalization/index.js';
import type { DataFetcher } from '@/modules/notification-delivery/core/ports.js';

const testLogger = pinoLogger({ level: 'silent' });
const REPORT_TYPE = 'Executie bugetara agregata la nivel de ordonator principal';

interface TotalsFixture {
  totalIncome: number;
  totalExpenses: number;
  budgetBalance: number;
}

const makeTotals = (
  totalIncome: string,
  totalExpenses: string,
  budgetBalance: string
): TotalsFixture => ({
  totalIncome: Number(totalIncome),
  totalExpenses: Number(totalExpenses),
  budgetBalance: Number(budgetBalance),
});

const makeClassificationRow = (
  functionalCode: string,
  amount: string
): ClassificationPeriodData => ({
  functional_code: functionalCode,
  functional_name: functionalCode,
  economic_code: '00.00.00',
  economic_name: 'Total',
  year: 2026,
  amount: new Decimal(amount),
  count: 1,
});

const makeAnalyticsAlertConfig = (
  filterOverrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  title: 'Învățământ alert',
  filter: {
    account_category: 'ch',
    normalization: 'total',
    inflation_adjusted: false,
    show_period_growth: false,
    report_period: {
      type: 'YEAR',
      selection: { dates: ['2025'] },
    },
    ...filterOverrides,
  },
  conditions: [],
});

const getPeriodDate = (period: AnalyticsFilter['report_period']): string => {
  return period.selection.dates?.[0] ?? '';
};

const makeFetcher = (input: {
  totalsByPeriod: Record<string, TotalsFixture>;
  ytdTotals?: {
    totalIncome: Decimal;
    totalExpenses: Decimal;
    budgetBalance: Decimal;
  };
  aggregatedRows?: ClassificationPeriodData[];
  normalizationFactors?: NormalizationFactors;
}): {
  fetcher: DataFetcher;
  getTotals: ReturnType<typeof vi.fn>;
  getMonthlyYtdTotals: ReturnType<typeof vi.fn>;
  getClassificationPeriodData: ReturnType<typeof vi.fn>;
} => {
  const getTotals = vi.fn(async (_entityCui: string, period: AnalyticsFilter['report_period']) => {
    const periodKey = getPeriodDate(period);
    return ok(input.totalsByPeriod[periodKey] ?? makeTotals('0', '0', '0'));
  });
  const getMonthlyYtdTotals = vi.fn(async () =>
    ok(
      input.ytdTotals ?? {
        totalIncome: new Decimal('0'),
        totalExpenses: new Decimal('0'),
        budgetBalance: new Decimal('0'),
      }
    )
  );
  const getClassificationPeriodData = vi.fn(async () =>
    ok({
      rows: input.aggregatedRows ?? [],
      distinctClassificationCount: input.aggregatedRows?.length ?? 0,
    })
  );

  const fetcher = makeBudgetDataFetcher({
    entityRepo: {
      getById: async (cui: string) =>
        ok({
          cui,
          name: 'Primaria Test',
          entity_type: 'Primarie',
          default_report_type: REPORT_TYPE,
          uat_id: null,
          is_uat: false,
          address: null,
          last_updated: null,
          main_creditor_1_cui: null,
          main_creditor_2_cui: null,
          tags: [],
        }),
    } as never,
    entityProfileRepo: {
      getByEntityCui: async () => ok(null),
    } as never,
    entityAnalyticsSummaryRepo: {
      getTotals,
    } as never,
    monthlyYtdTotalsReader: {
      getMonthlyYtdTotals,
    },
    aggregatedLineItemsRepo: {
      getClassificationPeriodData,
    } as never,
    normalization: {
      generateFactors: async () =>
        input.normalizationFactors ?? {
          cpi: new Map(),
          eur: new Map(),
          usd: new Map(),
          gdp: new Map(),
          population: new Map(),
        },
      normalize: async () => ok([]),
      invalidateCache: () => undefined,
    },
    populationRepo: {
      getFilteredPopulation: async () => ok(new Decimal(0)),
    } as never,
    datasetRepo: {} as never,
    logger: testLogger,
  });

  return {
    fetcher,
    getTotals,
    getMonthlyYtdTotals,
    getClassificationPeriodData,
  };
};

describe('toDeliveryError', () => {
  it('returns known delivery errors unchanged', () => {
    const error = createDatabaseError('db failed');

    expect(toDeliveryError('fallback', error)).toBe(error);
  });

  it('falls back for foreign typed objects', () => {
    const error = {
      type: 'SomeOtherError',
      message: 'foreign',
    };

    expect(toDeliveryError('fallback', error)).toEqual(createDatabaseError('fallback'));
  });

  it('falls back for plain Error instances', () => {
    expect(toDeliveryError('fallback', new Error('boom'))).toEqual(createDatabaseError('fallback'));
  });
});

describe('makeBudgetDataFetcher', () => {
  it('uses the calculation currency for empty-condition analytics alerts', async () => {
    const { fetcher, getClassificationPeriodData } = makeFetcher({
      totalsByPeriod: {},
      aggregatedRows: [makeClassificationRow('65.02', '39990667.8')],
      normalizationFactors: {
        cpi: new Map(),
        eur: new Map([['2026', new Decimal('5')]]),
        usd: new Map(),
        gdp: new Map(),
        population: new Map(),
      },
    });

    const result = await fetcher.fetchAlertData(
      makeAnalyticsAlertConfig({ currency: 'EUR' }),
      '2026-07'
    );

    expect(result.isOk()).toBe(true);
    const alertData = result._unsafeUnwrap();
    expect(alertData).not.toBeNull();
    if (alertData === null) {
      throw new Error('Expected analytics alert data');
    }

    expect(alertData.actualValue.toString()).toBe('7998133.56');
    expect(alertData.unit).toBe('EUR');
    expect(alertData.triggeredConditions).toEqual([]);
    expect(getClassificationPeriodData).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'EUR',
        normalization: 'total',
        report_period: {
          type: 'MONTH',
          selection: { dates: ['2026-07'] },
        },
      })
    );
  });

  it.each([
    ['an omitted currency', {}],
    ['a null currency', { currency: null }],
  ])('defaults %s to RON', async (_label, filterOverrides) => {
    const { fetcher, getClassificationPeriodData } = makeFetcher({
      totalsByPeriod: {},
      aggregatedRows: [],
    });

    const result = await fetcher.fetchAlertData(
      makeAnalyticsAlertConfig(filterOverrides),
      '2026-07'
    );

    expect(result.isOk()).toBe(true);
    const alertData = result._unsafeUnwrap();
    expect(alertData).not.toBeNull();
    if (alertData === null) {
      throw new Error('Expected analytics alert data');
    }

    expect(alertData.unit).toBe('RON');
    expect(getClassificationPeriodData).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'RON' })
    );
  });

  it('preserves the implicit EUR currency from legacy normalization', async () => {
    const { fetcher, getClassificationPeriodData } = makeFetcher({
      totalsByPeriod: {},
      aggregatedRows: [],
    });

    const result = await fetcher.fetchAlertData(
      makeAnalyticsAlertConfig({ normalization: 'total_euro' }),
      '2026-07'
    );

    expect(result.isOk()).toBe(true);
    const alertData = result._unsafeUnwrap();
    expect(alertData).not.toBeNull();
    if (alertData === null) {
      throw new Error('Expected analytics alert data');
    }

    expect(alertData.unit).toBe('EUR');
    expect(getClassificationPeriodData).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'EUR',
        normalization: 'total',
      })
    );
  });

  it('rejects an invalid analytics alert currency before querying data', async () => {
    const { fetcher, getClassificationPeriodData } = makeFetcher({
      totalsByPeriod: {},
      aggregatedRows: [],
    });

    const result = await fetcher.fetchAlertData(
      makeAnalyticsAlertConfig({ currency: 'GBP' }),
      '2026-07'
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      message: 'Analytics alert filter.currency is invalid',
    });
    expect(getClassificationPeriodData).not.toHaveBeenCalled();
  });

  it('returns separate monthly delta and YTD totals for monthly newsletters', async () => {
    const { fetcher, getMonthlyYtdTotals } = makeFetcher({
      totalsByPeriod: {
        '2026-03': makeTotals('100', '40', '60'),
        '2026-02': makeTotals('80', '30', '50'),
      },
      ytdTotals: {
        totalIncome: new Decimal('600'),
        totalExpenses: new Decimal('410'),
        budgetBalance: new Decimal('190'),
      },
    });

    const result = await fetcher.fetchNewsletterData('123', '2026-03', 'monthly');

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.periodLabel).toBe('martie 2026');
    expect(result.value.periodLabel).not.toBe('2026-03');
    expect(result.value.totalIncome.toString()).toBe('100');
    expect(result.value.monthlyDelta?.totalIncome.toString()).toBe('100');
    expect(result.value.ytdSummary?.totalIncome.toString()).toBe('600');
    expect(getMonthlyYtdTotals).toHaveBeenCalledWith({
      entityCui: '123',
      periodKey: '2026-03',
      reportType: REPORT_TYPE,
    });
  });

  it('calculates top expense percentages from filtered monthly category totals', async () => {
    const { fetcher, getClassificationPeriodData } = makeFetcher({
      totalsByPeriod: {
        '2026-03': makeTotals('508688538.67', '286933346.55', '221755192.12'),
        '2026-02': makeTotals('300', '200', '100'),
      },
      ytdTotals: {
        totalIncome: new Decimal('1017000000'),
        totalExpenses: new Decimal('620790000'),
        budgetBalance: new Decimal('397060000'),
      },
      aggregatedRows: [
        makeClassificationRow('84.02', '162690402.1'),
        makeClassificationRow('65.02', '33426583.74'),
        makeClassificationRow('67.02', '15999569.81'),
      ],
    });

    const result = await fetcher.fetchNewsletterData('123', '2026-03', 'monthly');

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.topExpenseCategories?.map((category) => category.name)).toEqual([
      'Transporturi',
      'Învățământ',
      'Cultură, recreere și religie',
    ]);
    expect(
      result.value.topExpenseCategories?.map((category) =>
        category.percentage.toDecimalPlaces(2).toString()
      )
    ).toEqual(['56.7', '11.65', '5.58']);

    expect(getClassificationPeriodData).toHaveBeenCalledOnce();
    expect(getClassificationPeriodData.mock.calls[0]?.[0]).toMatchObject({
      account_category: 'ch',
      report_type: REPORT_TYPE,
      entity_cuis: ['123'],
      exclude: {
        economic_prefixes: ['51.01', '51.02'],
      },
      report_period: {
        type: 'MONTH',
        selection: { dates: ['2026-03'] },
      },
    });
  });

  it('treats improving negative balances as positive movement', async () => {
    const { fetcher } = makeFetcher({
      totalsByPeriod: {
        '2026-03': makeTotals('100', '150', '-50'),
        '2026-02': makeTotals('100', '200', '-100'),
      },
    });

    const result = await fetcher.fetchNewsletterData('123', '2026-03', 'monthly');

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.previousPeriodComparison?.balanceChangeAmount.toString()).toBe('50');
    expect(result.value.previousPeriodComparison?.balanceChangePercent?.toString()).toBe('50');
  });

  it('treats worsening negative balances as negative movement', async () => {
    const { fetcher } = makeFetcher({
      totalsByPeriod: {
        '2026-03': makeTotals('100', '200', '-100'),
        '2026-02': makeTotals('100', '150', '-50'),
      },
    });

    const result = await fetcher.fetchNewsletterData('123', '2026-03', 'monthly');

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.previousPeriodComparison?.balanceChangeAmount.toString()).toBe('-50');
    expect(result.value.previousPeriodComparison?.balanceChangePercent?.toString()).toBe('-100');
  });

  it('treats crossing from deficit to surplus as positive balance movement', async () => {
    const { fetcher } = makeFetcher({
      totalsByPeriod: {
        '2026-03': makeTotals('125', '100', '25'),
        '2026-02': makeTotals('100', '150', '-50'),
      },
    });

    const result = await fetcher.fetchNewsletterData('123', '2026-03', 'monthly');

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.previousPeriodComparison?.balanceChangeAmount.toString()).toBe('75');
    expect(result.value.previousPeriodComparison?.balanceChangePercent?.toString()).toBe('150');
  });

  it('keeps available comparisons when a previous metric is zero', async () => {
    const { fetcher } = makeFetcher({
      totalsByPeriod: {
        '2026-03': makeTotals('100', '70', '30'),
        '2026-02': makeTotals('0', '50', '0'),
      },
    });

    const result = await fetcher.fetchNewsletterData('123', '2026-03', 'monthly');

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.previousPeriodComparison).toBeDefined();
    expect(result.value.previousPeriodComparison?.incomeChangePercent).toBeUndefined();
    expect(result.value.previousPeriodComparison?.expensesChangePercent?.toString()).toBe('40');
    expect(result.value.previousPeriodComparison?.balanceChangePercent).toBeUndefined();
    expect(result.value.previousPeriodComparison?.balanceChangeAmount.toString()).toBe('30');
  });
});
