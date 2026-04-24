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
}): {
  fetcher: DataFetcher;
  getTotals: ReturnType<typeof vi.fn>;
  getMonthlyYtdTotals: ReturnType<typeof vi.fn>;
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
      getClassificationPeriodData: async () =>
        ok({
          rows: [],
          distinctClassificationCount: 0,
        }),
    } as never,
    normalization: {
      generateFactors: async () => ({
        inflation: new Map(),
        exchangeRates: new Map(),
        gdp: new Map(),
      }),
      normalize: async () => ok([]),
      invalidateCache: () => undefined,
    } as never,
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
