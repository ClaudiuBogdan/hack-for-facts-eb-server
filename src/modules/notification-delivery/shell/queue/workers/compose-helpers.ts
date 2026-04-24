import { createHash } from 'node:crypto';

import { buildCampaignEntityUrl } from '@/common/utils/build-campaign-entity-url.js';

import type { TemplateError } from '../../../../email-templates/core/ports.js';
import type {
  BudgetSummary,
  FundingSourceBreakdown,
  PeriodComparison,
  PerCapitaMetrics,
  TopExpenseCategory,
  TriggeredCondition,
} from '../../../../email-templates/core/types.js';
import type { AlertData, NewsletterData, NewsletterFinancialSummary } from '../../../core/ports.js';
import type { Decimal } from 'decimal.js';

export interface BundleComposeError {
  message: string;
  retryable: boolean;
}

export interface NewsletterTemplateFields {
  entityName: string;
  entityCui: string;
  entityType?: string;
  countyName?: string;
  population?: number;
  summary: BudgetSummary;
  monthlyDelta?: BudgetSummary;
  ytdSummary?: BudgetSummary;
  previousPeriodComparison?: PeriodComparison;
  topExpenseCategories?: TopExpenseCategory[];
  fundingSources?: FundingSourceBreakdown[];
  perCapita?: PerCapitaMetrics;
  mapUrl?: string;
}

export interface MonthlyNewsletterTemplateFields extends NewsletterTemplateFields {
  monthlyDelta: BudgetSummary;
  ytdSummary: BudgetSummary;
}

export const hasMonthlyNewsletterTemplateFields = (
  fields: NewsletterTemplateFields
): fields is MonthlyNewsletterTemplateFields => {
  return fields.monthlyDelta !== undefined && fields.ytdSummary !== undefined;
};

export const hashContent = (html: string, text: string): string => {
  return createHash('sha256').update(html).update(text).digest('hex').substring(0, 16);
};

export const buildNotificationSettingsUrl = (platformBaseUrl: string): string => {
  return `${platformBaseUrl}/settings/notifications`;
};

export const buildCampaignPreferencesUrl = (clientBaseUrl: string): string => {
  return `${clientBaseUrl}/provocare/notificari`;
};

const trimTrailingSlashes = (baseUrl: string): string => baseUrl.replace(/\/+$/u, '');

const MONTHLY_PERIOD_KEY_REGEX = /^(\d{4})-(\d{2})$/u;

export const buildEntityReportUrl = (
  platformBaseUrl: string,
  entityCui: string,
  periodKey: string,
  periodType: 'monthly' | 'quarterly' | 'yearly'
): string => {
  const entityUrl = `${trimTrailingSlashes(platformBaseUrl)}/entities/${encodeURIComponent(entityCui)}`;

  if (periodType !== 'monthly') {
    return entityUrl;
  }

  const periodMatch = MONTHLY_PERIOD_KEY_REGEX.exec(periodKey);
  if (periodMatch?.[1] === undefined || periodMatch[2] === undefined) {
    return entityUrl;
  }

  const params = new URLSearchParams({
    period: 'MONTH',
    normalization: 'total',
    year: periodMatch[1],
    month: periodMatch[2],
  });

  return `${entityUrl}?${params.toString()}`;
};

export { buildCampaignEntityUrl };

export const toDecimalString = (value: Decimal): string => value.toString();

const mapFinancialSummaryToTemplateFields = (
  summary: NewsletterFinancialSummary,
  currency: string
): BudgetSummary => ({
  totalIncome: toDecimalString(summary.totalIncome),
  totalExpenses: toDecimalString(summary.totalExpenses),
  budgetBalance: toDecimalString(summary.budgetBalance),
  currency,
});

export const getPeriodYear = (periodKey: string): number => {
  const matchedYear = /^(\d{4})/u.exec(periodKey);
  if (matchedYear?.[1] === undefined) {
    return 1970;
  }

  const year = Number.parseInt(matchedYear[1], 10);
  return Number.isNaN(year) ? 1970 : year;
};

export const getPeriodType = (notificationType: string): 'monthly' | 'quarterly' | 'yearly' => {
  if (notificationType.includes('monthly')) return 'monthly';
  if (notificationType.includes('quarterly')) return 'quarterly';
  if (notificationType.includes('yearly')) return 'yearly';
  return 'monthly';
};

export const formatTemplateError = (error: TemplateError): string => {
  return `${error.type}: ${error.message}`;
};

export const mapTriggeredConditionsToTemplateFields = (
  triggeredConditions: AlertData['triggeredConditions']
): TriggeredCondition[] => {
  return triggeredConditions.map((condition) => ({
    ...condition,
    threshold: toDecimalString(condition.threshold),
    actualValue: toDecimalString(condition.actualValue),
  }));
};

export const mapNewsletterDataToTemplateFields = (
  data: NewsletterData
): NewsletterTemplateFields => {
  return {
    entityName: data.entityName,
    entityCui: data.entityCui,
    summary: {
      totalIncome: toDecimalString(data.totalIncome),
      totalExpenses: toDecimalString(data.totalExpenses),
      budgetBalance: toDecimalString(data.budgetBalance),
      currency: data.currency,
    },
    ...(data.monthlyDelta !== undefined
      ? { monthlyDelta: mapFinancialSummaryToTemplateFields(data.monthlyDelta, data.currency) }
      : {}),
    ...(data.ytdSummary !== undefined
      ? { ytdSummary: mapFinancialSummaryToTemplateFields(data.ytdSummary, data.currency) }
      : {}),
    ...(data.entityType !== undefined ? { entityType: data.entityType } : {}),
    ...(data.countyName !== undefined ? { countyName: data.countyName } : {}),
    ...(data.population !== undefined ? { population: data.population } : {}),
    ...(data.previousPeriodComparison !== undefined
      ? {
          previousPeriodComparison: {
            ...(data.previousPeriodComparison.incomeChangePercent !== undefined
              ? {
                  incomeChangePercent: toDecimalString(
                    data.previousPeriodComparison.incomeChangePercent
                  ),
                }
              : {}),
            ...(data.previousPeriodComparison.expensesChangePercent !== undefined
              ? {
                  expensesChangePercent: toDecimalString(
                    data.previousPeriodComparison.expensesChangePercent
                  ),
                }
              : {}),
            ...(data.previousPeriodComparison.balanceChangePercent !== undefined
              ? {
                  balanceChangePercent: toDecimalString(
                    data.previousPeriodComparison.balanceChangePercent
                  ),
                }
              : {}),
            balanceChangeAmount: toDecimalString(data.previousPeriodComparison.balanceChangeAmount),
          },
        }
      : {}),
    ...(data.topExpenseCategories !== undefined
      ? {
          topExpenseCategories: data.topExpenseCategories.map((category) => ({
            ...category,
            amount: toDecimalString(category.amount),
            percentage: toDecimalString(category.percentage),
          })),
        }
      : {}),
    ...(data.fundingSources !== undefined
      ? {
          fundingSources: data.fundingSources.map((source) => ({
            ...source,
            percentage: toDecimalString(source.percentage),
          })),
        }
      : {}),
    ...(data.perCapita !== undefined
      ? {
          perCapita: {
            income: toDecimalString(data.perCapita.income),
            expenses: toDecimalString(data.perCapita.expenses),
          },
        }
      : {}),
    ...(data.mapUrl !== undefined ? { mapUrl: data.mapUrl } : {}),
  };
};
