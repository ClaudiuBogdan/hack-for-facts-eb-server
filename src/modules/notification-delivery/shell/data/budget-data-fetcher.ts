import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import { formatPeriodLabel } from '@/common/utils/format-period-label.js';
import {
  getAggregatedLineItems,
  type AggregatedLineItemsRepository,
} from '@/modules/aggregated-line-items/index.js';

import { resolveChapterName } from './functional-chapter-map.js';
import {
  createDatabaseError,
  createValidationError,
  isDeliveryError,
  type DeliveryError,
} from '../../core/errors.js';

import type {
  AlertData,
  DataFetcher,
  NewsletterData,
  NewsletterFinancialSummary,
} from '../../core/ports.js';
import type { AnalyticsFilter, PeriodDate } from '@/common/types/analytics.js';
import type { BudgetDbClient } from '@/infra/database/client.js';
import type { DatasetRepo } from '@/modules/datasets/index.js';
import type {
  EntityAnalyticsSummaryRepository,
  EntityProfileRepository,
  EntityRepository,
} from '@/modules/entity/index.js';
import type { PopulationRepository, NormalizationPort } from '@/modules/normalization/index.js';
import type {
  AnalyticsSeriesAlertConfig,
  AlertCondition,
  NotificationConfig,
  StaticSeriesAlertConfig,
} from '@/modules/notifications/core/types.js';
import type { Logger } from 'pino';

const DEFAULT_TOP_CATEGORIES_LIMIT = 5;
const MAX_AGGREGATED_ITEMS_LIMIT = 100_000;
const DEFAULT_CURRENCY = 'RON';

const toDecimal = (value: Decimal | number | string): Decimal => {
  return value instanceof Decimal ? value : new Decimal(value);
};

export const toDeliveryError = (message: string, error: unknown): DeliveryError => {
  if (isDeliveryError(error)) {
    return error;
  }

  return createDatabaseError(message);
};

const buildReportPeriod = (
  periodKey: string,
  periodType: 'monthly' | 'quarterly' | 'yearly'
): AnalyticsFilter['report_period'] => {
  switch (periodType) {
    case 'monthly':
      return {
        type: Frequency.MONTH,
        selection: { dates: [periodKey as PeriodDate] },
      };
    case 'quarterly':
      return {
        type: Frequency.QUARTER,
        selection: { dates: [periodKey as PeriodDate] },
      };
    case 'yearly':
    default:
      return {
        type: Frequency.YEAR,
        selection: { dates: [periodKey as PeriodDate] },
      };
  }
};

const getPreviousPeriodKey = (
  periodKey: string,
  periodType: 'monthly' | 'quarterly' | 'yearly'
): string | null => {
  switch (periodType) {
    case 'monthly': {
      const [yearPart, monthPart] = periodKey.split('-');
      const year = Number.parseInt(yearPart ?? '', 10);
      const month = Number.parseInt(monthPart ?? '', 10);
      if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
        return null;
      }

      const previous = new Date(Date.UTC(year, month - 2, 1));
      return `${String(previous.getUTCFullYear())}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    case 'quarterly': {
      const [yearPart, quarterPart] = periodKey.split('-Q');
      const year = Number.parseInt(yearPart ?? '', 10);
      const quarter = Number.parseInt(quarterPart ?? '', 10);
      if (Number.isNaN(year) || Number.isNaN(quarter) || quarter < 1 || quarter > 4) {
        return null;
      }

      if (quarter === 1) {
        return `${String(year - 1)}-Q4`;
      }

      return `${String(year)}-Q${String(quarter - 1)}`;
    }
    case 'yearly': {
      const year = Number.parseInt(periodKey, 10);
      if (Number.isNaN(year)) {
        return null;
      }

      return String(year - 1);
    }
  }
};

const calculatePercentChange = (current: Decimal, previous: Decimal): Decimal | undefined => {
  if (previous.isZero()) {
    return undefined;
  }

  return current.minus(previous).div(previous).mul(100);
};

const calculateBalancePercentChange = (
  current: Decimal,
  previous: Decimal
): Decimal | undefined => {
  if (previous.isZero()) {
    return undefined;
  }

  return current.minus(previous).div(previous.abs()).mul(100);
};

const normalizeFilterObject = (value: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {};
  const keyMap: Record<string, string> = {
    accountCategory: 'account_category',
    reportType: 'report_type',
    entityCuis: 'entity_cuis',
    mainCreditorCui: 'main_creditor_cui',
    functionalCodes: 'functional_codes',
    functionalPrefixes: 'functional_prefixes',
    economicCodes: 'economic_codes',
    economicPrefixes: 'economic_prefixes',
    fundingSourceIds: 'funding_source_ids',
    budgetSectorIds: 'budget_sector_ids',
    expenseTypes: 'expense_types',
    programCodes: 'program_codes',
    countyCodes: 'county_codes',
    uatIds: 'uat_ids',
    entityTypes: 'entity_types',
    minPopulation: 'min_population',
    maxPopulation: 'max_population',
    aggregateMinAmount: 'aggregate_min_amount',
    aggregateMaxAmount: 'aggregate_max_amount',
    itemMinAmount: 'item_min_amount',
    itemMaxAmount: 'item_max_amount',
    isUat: 'is_uat',
    reportPeriod: 'report_period',
  };

  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = keyMap[key] ?? key;
    if (
      normalizedKey === 'exclude' &&
      rawValue !== null &&
      typeof rawValue === 'object' &&
      !Array.isArray(rawValue)
    ) {
      normalized[normalizedKey] = normalizeFilterObject(rawValue as Record<string, unknown>);
      continue;
    }

    normalized[normalizedKey] = rawValue;
  }

  return normalized;
};

const isAnalyticsAlertConfig = (
  config: NotificationConfig
): config is AnalyticsSeriesAlertConfig => {
  return (
    config !== null &&
    typeof config === 'object' &&
    Array.isArray((config as { conditions?: unknown }).conditions) &&
    typeof (config as { filter?: unknown }).filter === 'object' &&
    (config as { filter?: unknown }).filter !== null
  );
};

const isStaticAlertConfig = (config: NotificationConfig): config is StaticSeriesAlertConfig => {
  return (
    config !== null &&
    typeof config === 'object' &&
    Array.isArray((config as { conditions?: unknown }).conditions) &&
    typeof (config as { datasetId?: unknown }).datasetId === 'string'
  );
};

const evaluateAlertCondition = (actualValue: Decimal, condition: AlertCondition): boolean => {
  const threshold = new Decimal(condition.threshold);

  switch (condition.operator) {
    case 'gt':
      return actualValue.gt(threshold);
    case 'gte':
      return actualValue.gte(threshold);
    case 'lt':
      return actualValue.lt(threshold);
    case 'lte':
      return actualValue.lte(threshold);
    case 'eq':
      return actualValue.eq(threshold);
  }
};

const buildTriggeredConditions = (
  actualValue: Decimal,
  conditions: AlertCondition[]
): AlertData['triggeredConditions'] => {
  return conditions
    .filter((condition) => evaluateAlertCondition(actualValue, condition))
    .map((condition) => ({
      operator: condition.operator,
      threshold: new Decimal(condition.threshold),
      actualValue,
      unit: condition.unit,
    }));
};

const resolveAccountCategory = (value: unknown): 'vn' | 'ch' | null => {
  if (value === 'vn' || value === 'ch') {
    return value;
  }

  return null;
};

export interface BudgetDataFetcherConfig {
  entityRepo: EntityRepository;
  entityProfileRepo: EntityProfileRepository;
  entityAnalyticsSummaryRepo: EntityAnalyticsSummaryRepository;
  monthlyYtdTotalsReader: MonthlyYtdTotalsReader;
  aggregatedLineItemsRepo: AggregatedLineItemsRepository;
  normalization: NormalizationPort;
  populationRepo: PopulationRepository;
  datasetRepo: DatasetRepo;
  logger: Logger;
}

export interface MonthlyYtdTotalsReaderInput {
  entityCui: string;
  periodKey: string;
  reportType: string;
}

export interface MonthlyYtdTotalsReader {
  getMonthlyYtdTotals(
    input: MonthlyYtdTotalsReaderInput
  ): Promise<Result<NewsletterFinancialSummary, DeliveryError>>;
}

export interface BudgetMonthlyYtdTotalsReaderConfig {
  budgetDb: BudgetDbClient;
  logger: Logger;
}

const parseMonthlyPeriodKey = (periodKey: string): { year: number; month: number } | null => {
  const match = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/u.exec(periodKey);
  if (match?.groups === undefined) {
    return null;
  }

  const year = Number.parseInt(match.groups['year'] ?? '', 10);
  const month = Number.parseInt(match.groups['month'] ?? '', 10);

  if (Number.isNaN(year) || Number.isNaN(month)) {
    return null;
  }

  return { year, month };
};

interface MonthlyYtdTotalsRow {
  total_income: string | null;
  total_expense: string | null;
  budget_balance: string | null;
}

export const makeBudgetMonthlyYtdTotalsReader = ({
  budgetDb,
  logger,
}: BudgetMonthlyYtdTotalsReaderConfig): MonthlyYtdTotalsReader => {
  const log = logger.child({ component: 'BudgetMonthlyYtdTotalsReader' });

  return {
    async getMonthlyYtdTotals({
      entityCui,
      periodKey,
      reportType,
    }: MonthlyYtdTotalsReaderInput): Promise<Result<NewsletterFinancialSummary, DeliveryError>> {
      const parsedPeriod = parseMonthlyPeriodKey(periodKey);
      if (parsedPeriod === null) {
        return err(createValidationError(`Invalid monthly period key '${periodKey}'`));
      }

      try {
        const result = await sql<MonthlyYtdTotalsRow>`
          SELECT
            COALESCE(SUM(CASE WHEN eli.account_category = 'vn' THEN eli.ytd_amount ELSE 0 END), 0)::text AS total_income,
            COALESCE(SUM(CASE WHEN eli.account_category = 'ch' THEN eli.ytd_amount ELSE 0 END), 0)::text AS total_expense,
            COALESCE(SUM(CASE WHEN eli.account_category = 'vn' THEN eli.ytd_amount ELSE -eli.ytd_amount END), 0)::text AS budget_balance
          FROM executionlineitems eli
          WHERE eli.entity_cui = ${entityCui}
            AND eli.report_type = ${reportType}
            AND eli.year = ${parsedPeriod.year}
            AND eli.month = ${parsedPeriod.month}
            AND NOT (
              eli.account_category = 'ch' AND (
                eli.economic_code LIKE '51.01%' OR
                eli.economic_code LIKE '51.02%'
              )
            )
            AND NOT (
              eli.account_category = 'vn' AND (
                eli.functional_code LIKE '36.02.05%' OR
                eli.functional_code LIKE '37.02.03%' OR
                eli.functional_code LIKE '37.02.04%' OR
                eli.functional_code LIKE '47.02.04%'
              )
            )
        `.execute(budgetDb);

        const row = result.rows[0];

        return ok({
          totalIncome: new Decimal(row?.total_income ?? '0'),
          totalExpenses: new Decimal(row?.total_expense ?? '0'),
          budgetBalance: new Decimal(row?.budget_balance ?? '0'),
        });
      } catch (error) {
        log.warn({ entityCui, periodKey, error }, 'Failed to load monthly YTD totals');
        return err(createDatabaseError('Failed to load monthly YTD totals'));
      }
    },
  };
};

export const makeBudgetDataFetcher = (config: BudgetDataFetcherConfig): DataFetcher => {
  const {
    entityRepo,
    entityProfileRepo,
    entityAnalyticsSummaryRepo,
    monthlyYtdTotalsReader,
    aggregatedLineItemsRepo,
    normalization,
    populationRepo,
    datasetRepo,
    logger,
  } = config;
  const log = logger.child({ component: 'BudgetDataFetcher' });

  const loadTopExpenseCategories = async (
    entityCui: string,
    periodKey: string,
    periodType: 'monthly' | 'quarterly' | 'yearly',
    totalExpenses: Decimal
  ): Promise<NewsletterData['topExpenseCategories']> => {
    const result = await getAggregatedLineItems(
      {
        repo: aggregatedLineItemsRepo,
        normalization,
        populationRepo,
      },
      {
        filter: {
          account_category: 'ch',
          entity_cuis: [entityCui],
          report_period: buildReportPeriod(periodKey, periodType),
          normalization: 'total',
          inflation_adjusted: false,
          show_period_growth: false,
        },
        limit: MAX_AGGREGATED_ITEMS_LIMIT,
        offset: 0,
      }
    );

    if (result.isErr()) {
      log.warn(
        { entityCui, periodKey, error: result.error },
        'Failed to load top expense categories for newsletter data'
      );
      return undefined;
    }

    if (result.value.nodes.length === 0) {
      return undefined;
    }

    // Aggregate line items by functional chapter (first segment of code)
    const chapterTotals = new Map<string, Decimal>();

    for (const node of result.value.nodes) {
      const chapterCode = node.functional_code.split('.')[0] ?? node.functional_code;
      const existing = chapterTotals.get(chapterCode) ?? new Decimal(0);
      chapterTotals.set(chapterCode, existing.plus(new Decimal(node.amount)));
    }

    const sortedChapters = [...chapterTotals.entries()]
      .sort((a, b) => b[1].cmp(a[1]))
      .slice(0, DEFAULT_TOP_CATEGORIES_LIMIT);

    return sortedChapters.map(([chapterCode, amount]) => ({
      name: resolveChapterName(chapterCode),
      amount,
      percentage: totalExpenses.isZero() ? new Decimal(0) : amount.div(totalExpenses).mul(100),
    }));
  };

  const loadPopulation = async (
    entityCui: string,
    periodKey: string,
    periodType: 'monthly' | 'quarterly' | 'yearly'
  ): Promise<Decimal | undefined> => {
    const populationResult = await populationRepo.getFilteredPopulation({
      account_category: 'ch',
      entity_cuis: [entityCui],
      report_period: buildReportPeriod(periodKey, periodType),
    });

    if (populationResult.isErr()) {
      log.warn(
        { entityCui, periodKey, error: populationResult.error },
        'Failed to load population for newsletter data'
      );
      return undefined;
    }

    return populationResult.value.lte(0) ? undefined : populationResult.value;
  };

  return {
    async fetchNewsletterData(
      entityCui: string,
      periodKey: string,
      periodType: 'monthly' | 'quarterly' | 'yearly'
    ): Promise<Result<NewsletterData, DeliveryError>> {
      const entityResult = await entityRepo.getById(entityCui);
      if (entityResult.isErr()) {
        return err(
          toDeliveryError('Failed to load entity for newsletter notification', entityResult.error)
        );
      }

      const entity = entityResult.value;
      if (entity === null) {
        return err(createValidationError(`Entity '${entityCui}' not found`));
      }

      const period = buildReportPeriod(periodKey, periodType);
      const totalsResult = await entityAnalyticsSummaryRepo.getTotals(
        entityCui,
        period,
        entity.default_report_type
      );

      if (totalsResult.isErr()) {
        return err(
          toDeliveryError(
            'Failed to load entity totals for newsletter notification',
            totalsResult.error
          )
        );
      }

      const totals = totalsResult.value;
      const totalIncome = toDecimal(totals.totalIncome);
      const totalExpenses = toDecimal(totals.totalExpenses);
      const budgetBalance = toDecimal(totals.budgetBalance);
      const monthlyDelta =
        periodType === 'monthly'
          ? {
              totalIncome,
              totalExpenses,
              budgetBalance,
            }
          : undefined;

      const ytdSummaryResult =
        periodType === 'monthly'
          ? await monthlyYtdTotalsReader.getMonthlyYtdTotals({
              entityCui,
              periodKey,
              reportType: entity.default_report_type,
            })
          : undefined;

      if (ytdSummaryResult?.isErr() === true) {
        return err(ytdSummaryResult.error);
      }

      const ytdSummary = ytdSummaryResult?.isOk() === true ? ytdSummaryResult.value : undefined;

      const [profileResult, previousPeriodKey, population, topExpenseCategories] =
        await Promise.all([
          entityProfileRepo.getByEntityCui(entityCui),
          Promise.resolve(getPreviousPeriodKey(periodKey, periodType)),
          loadPopulation(entityCui, periodKey, periodType),
          loadTopExpenseCategories(entityCui, periodKey, periodType, totalExpenses),
        ]);

      const previousPeriodComparison =
        previousPeriodKey === null
          ? undefined
          : await (async () => {
              const previousTotalsResult = await entityAnalyticsSummaryRepo.getTotals(
                entityCui,
                buildReportPeriod(previousPeriodKey, periodType),
                entity.default_report_type
              );

              if (previousTotalsResult.isErr()) {
                log.warn(
                  { entityCui, periodKey, previousPeriodKey, error: previousTotalsResult.error },
                  'Failed to load previous period totals for newsletter comparison'
                );
                return undefined;
              }

              const previousTotals = previousTotalsResult.value;
              const incomeChangePercent = calculatePercentChange(
                totalIncome,
                toDecimal(previousTotals.totalIncome)
              );
              const expensesChangePercent = calculatePercentChange(
                totalExpenses,
                toDecimal(previousTotals.totalExpenses)
              );
              const previousBudgetBalance = toDecimal(previousTotals.budgetBalance);
              const balanceChangePercent = calculateBalancePercentChange(
                budgetBalance,
                previousBudgetBalance
              );
              const balanceChangeAmount = budgetBalance.minus(previousBudgetBalance);

              return {
                ...(incomeChangePercent !== undefined ? { incomeChangePercent } : {}),
                ...(expensesChangePercent !== undefined ? { expensesChangePercent } : {}),
                ...(balanceChangePercent !== undefined ? { balanceChangePercent } : {}),
                balanceChangeAmount,
              };
            })();

      const profile = profileResult.isOk() ? profileResult.value : null;
      if (profileResult.isErr()) {
        log.warn(
          { entityCui, error: profileResult.error },
          'Failed to load entity profile for newsletter data'
        );
      }

      return ok({
        entityName: entity.name,
        entityCui: entity.cui,
        periodLabel: formatPeriodLabel(periodKey, periodType),
        totalIncome,
        totalExpenses,
        budgetBalance,
        currency: DEFAULT_CURRENCY,
        ...(monthlyDelta !== undefined ? { monthlyDelta } : {}),
        ...(ytdSummary !== undefined ? { ytdSummary } : {}),
        ...(entity.entity_type !== null ? { entityType: entity.entity_type } : {}),
        ...(profile?.county_name !== null && profile?.county_name !== undefined
          ? { countyName: profile.county_name }
          : {}),
        ...(population !== undefined ? { population: population.toNumber() } : {}),
        ...(previousPeriodComparison !== undefined ? { previousPeriodComparison } : {}),
        ...(topExpenseCategories !== undefined ? { topExpenseCategories } : {}),
        ...(population !== undefined && !population.isZero()
          ? {
              perCapita: {
                income: totalIncome.div(population),
                expenses: totalExpenses.div(population),
              },
            }
          : {}),
      });
    },

    async fetchAlertData(
      configValue: Record<string, unknown>,
      periodKey: string
    ): Promise<Result<AlertData | null, DeliveryError>> {
      const config = configValue as unknown as NotificationConfig;

      if (isAnalyticsAlertConfig(config)) {
        const normalizedFilter = normalizeFilterObject(config.filter);
        const accountCategory = resolveAccountCategory(normalizedFilter['account_category']);

        if (accountCategory === null) {
          return err(createValidationError('Analytics alert filter.account_category is required'));
        }

        const filter: AnalyticsFilter & {
          normalization: 'total';
          inflation_adjusted: false;
          show_period_growth: false;
        } = {
          ...(normalizedFilter as unknown as AnalyticsFilter),
          account_category: accountCategory,
          report_period: buildReportPeriod(periodKey, 'monthly'),
          normalization: 'total',
          inflation_adjusted: false,
          show_period_growth: false,
        };

        const result = await getAggregatedLineItems(
          {
            repo: aggregatedLineItemsRepo,
            normalization,
            populationRepo,
          },
          {
            filter,
            limit: MAX_AGGREGATED_ITEMS_LIMIT,
            offset: 0,
          }
        );

        if (result.isErr()) {
          return err(toDeliveryError('Failed to load analytics alert data', result.error));
        }

        const actualValue = result.value.nodes.reduce((sum, node) => {
          return sum.plus(new Decimal(node.amount));
        }, new Decimal(0));
        const triggeredConditions = buildTriggeredConditions(actualValue, config.conditions);
        const unit = config.conditions[0]?.unit ?? DEFAULT_CURRENCY;

        return ok({
          title: config.title ?? 'Alerta bugetara',
          ...(config.description !== undefined ? { description: config.description } : {}),
          actualValue,
          unit,
          triggeredConditions,
        });
      }

      if (isStaticAlertConfig(config)) {
        const datasetResult = await datasetRepo.getById(config.datasetId);
        if (datasetResult.isErr()) {
          return err(toDeliveryError('Failed to load static alert dataset', datasetResult.error));
        }

        const point = datasetResult.value.points.find((candidate) => candidate.x === periodKey);
        if (point === undefined) {
          return ok(null);
        }

        const triggeredConditions = buildTriggeredConditions(point.y, config.conditions);
        const unit = config.conditions[0]?.unit ?? '';

        return ok({
          title: config.title ?? datasetResult.value.i18n.ro.title,
          ...((config.description ?? datasetResult.value.i18n.ro.description) !== undefined
            ? { description: config.description ?? datasetResult.value.i18n.ro.description }
            : {}),
          actualValue: point.y,
          unit,
          triggeredConditions,
        });
      }

      return err(
        createValidationError('Unsupported alert configuration for notification delivery')
      );
    },
  };
};
