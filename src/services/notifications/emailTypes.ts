import type { ReportPeriodType } from '../../types';

export interface EntityNewsletterContent {
  entityName: string;
  entityCui: string;
  periodKey: string; // Human readable label or period string
  granularity: ReportPeriodType;
  summary: {
    totalSpending: number;
    totalIncome: number;
    balance: number;
    executionRate?: number;
  };
  comparisons?: {
    vsPrevious?: { expensesAbs: number; expensesPct?: number; incomeAbs: number; incomePct?: number };
    vsYoY?: { expensesAbs: number; expensesPct?: number; incomeAbs: number; incomePct?: number };
  };
  topFunctional?: Array<{ code: string; name?: string; amount: number }>;
  topEconomic?: Array<{ code: string; name?: string; amount: number }>;
  trend?: Array<{ x: string; y: number }>;
  entityUrl?: string;
}

export interface SeriesAlertDetails {
  currentValue?: number;
  threshold?: number;
  difference?: number;
  percentChange?: number;
}

export interface SeriesAlertEmailContent {
  alertTitle?: string;
  alertMessage?: string;
  details?: SeriesAlertDetails;
  periodKey?: string;
  entityUrl?: string;
  comparisons?: {
    prev?: { abs?: number; pct?: number };
    yoy?: { abs?: number; pct?: number };
  };
  stats?: { min: number; max: number; avg: number; count: number };
  conditions?: Array<{ operator: 'gt'|'gte'|'lt'|'lte'|'eq'; threshold: number; unit: string; met: boolean }>;
  series?: {
    xAxis: { unit: string };
    yAxis: { unit: string };
  };
}

export type EmailSectionContent = EntityNewsletterContent | SeriesAlertEmailContent;

export type EmailSectionType = 'entity_newsletter' | 'alert';

export interface EmailSection {
  type: EmailSectionType;
  title: string;
  content: EmailSectionContent;
  unsubscribeUrl: string;
}

export interface ConsolidatedEmailData {
  userEmail: string;
  sections: EmailSection[];
  baseUrl: string;
}
