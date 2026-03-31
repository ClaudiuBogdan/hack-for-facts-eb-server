import { createHash } from 'node:crypto';

import type { TemplateError } from '../../../../email-templates/core/ports.js';
import type {
  BudgetSummary,
  FundingSourceBreakdown,
  PeriodComparison,
  PerCapitaMetrics,
  TopExpenseCategory,
  TriggeredCondition,
} from '../../../../email-templates/core/types.js';
import type { AlertData, NewsletterData } from '../../../core/ports.js';
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
  previousPeriodComparison?: PeriodComparison;
  topExpenseCategories?: TopExpenseCategory[];
  fundingSources?: FundingSourceBreakdown[];
  perCapita?: PerCapitaMetrics;
  mapUrl?: string;
}

export const hashContent = (html: string, text: string): string => {
  return createHash('sha256').update(html).update(text).digest('hex').substring(0, 16);
};

export const buildNotificationSettingsUrl = (platformBaseUrl: string): string => {
  return `${platformBaseUrl}/settings/notifications`;
};

export const toDecimalString = (value: Decimal): string => value.toString();

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
    ...(data.entityType !== undefined ? { entityType: data.entityType } : {}),
    ...(data.countyName !== undefined ? { countyName: data.countyName } : {}),
    ...(data.population !== undefined ? { population: data.population } : {}),
    ...(data.previousPeriodComparison !== undefined
      ? {
          previousPeriodComparison: {
            incomeChangePercent: toDecimalString(data.previousPeriodComparison.incomeChangePercent),
            expensesChangePercent: toDecimalString(
              data.previousPeriodComparison.expensesChangePercent
            ),
            balanceChangePercent: toDecimalString(
              data.previousPeriodComparison.balanceChangePercent
            ),
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
