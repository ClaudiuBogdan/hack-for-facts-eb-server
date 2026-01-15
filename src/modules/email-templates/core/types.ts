/**
 * Email Templates Module - Core Types
 *
 * Type definitions for email template rendering.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Language Support
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported languages for email content.
 */
export type SupportedLanguage = 'ro' | 'en';

/**
 * Default language for emails.
 */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'ro';

// ─────────────────────────────────────────────────────────────────────────────
// Base Template Props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base properties for all email templates.
 */
export interface BaseTemplateProps {
  /** Language for email content */
  lang: SupportedLanguage;
  /** URL for one-click unsubscribe */
  unsubscribeUrl: string;
  /** URL for notification preferences */
  preferencesUrl?: string;
  /** Platform base URL */
  platformBaseUrl: string;
  /** Whether this is a preview render */
  isPreview?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Newsletter Template Props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Newsletter period types.
 */
export type NewsletterPeriodType = 'monthly' | 'quarterly' | 'yearly';

/**
 * Budget summary data for newsletter.
 */
export interface BudgetSummary {
  /** Total income for the period */
  totalIncome: number;
  /** Total expenses for the period */
  totalExpenses: number;
  /** Budget balance (income - expenses) */
  budgetBalance: number;
  /** Currency code (e.g., 'RON') */
  currency: string;
}

/**
 * Period-over-period comparison data.
 */
export interface PeriodComparison {
  /** Income change percentage vs previous period */
  incomeChangePercent: number;
  /** Expenses change percentage vs previous period */
  expensesChangePercent: number;
  /** Balance change percentage vs previous period */
  balanceChangePercent: number;
}

/**
 * Top expense category data.
 */
export interface TopExpenseCategory {
  /** Category name (e.g., "Învățământ") */
  name: string;
  /** Amount spent in this category */
  amount: number;
  /** Percentage of total expenses */
  percentage: number;
}

/**
 * Funding source breakdown data.
 */
export interface FundingSourceBreakdown {
  /** Funding source name (e.g., "Buget local") */
  name: string;
  /** Percentage of total funding */
  percentage: number;
}

/**
 * Per capita metrics for UATs.
 */
export interface PerCapitaMetrics {
  /** Income per capita */
  income: number;
  /** Expenses per capita */
  expenses: number;
}

/**
 * Props for entity newsletter templates.
 */
export interface NewsletterEntityProps extends BaseTemplateProps {
  templateType: 'newsletter_entity';

  // ── Entity Information ─────────────────────────────────────────────────────
  /** Entity name (e.g., "Primăria București") */
  entityName: string;
  /** Entity CUI (unique identifier) */
  entityCui: string;
  /** Entity type (e.g., "Primărie Municipiu", "UAT") */
  entityType?: string;
  /** County name (e.g., "București", "Sibiu") */
  countyName?: string;
  /** Population count (for UATs) */
  population?: number;

  // ── Period Information ─────────────────────────────────────────────────────
  /** Newsletter period type */
  periodType: NewsletterPeriodType;
  /** Human-readable period label (e.g., "Ianuarie 2025") */
  periodLabel: string;

  // ── Financial Summary ──────────────────────────────────────────────────────
  /** Budget summary data */
  summary: BudgetSummary;
  /** Period-over-period comparison */
  previousPeriodComparison?: PeriodComparison;

  // ── Detailed Breakdowns ────────────────────────────────────────────────────
  /** Top 5 expense categories */
  topExpenseCategories?: TopExpenseCategory[];
  /** Funding source breakdown */
  fundingSources?: FundingSourceBreakdown[];
  /** Per capita metrics (for UATs with population) */
  perCapita?: PerCapitaMetrics;

  // ── Links ──────────────────────────────────────────────────────────────────
  /** URL to view full details */
  detailsUrl?: string;
  /** URL to explore on map */
  mapUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Template Props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alert operators for conditions.
 */
export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

/**
 * A triggered alert condition.
 */
export interface TriggeredCondition {
  /** Comparison operator */
  operator: AlertOperator;
  /** Threshold value */
  threshold: number;
  /** Actual value that triggered the alert */
  actualValue: number;
  /** Unit of measurement */
  unit: string;
}

/**
 * Props for alert series templates.
 */
export interface AlertSeriesProps extends BaseTemplateProps {
  templateType: 'alert_series';
  /** Alert title */
  title: string;
  /** Optional description */
  description?: string;
  /** Conditions that triggered the alert */
  triggeredConditions: TriggeredCondition[];
  /** URL to view the data source */
  dataSourceUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Union Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible email template props.
 */
export type EmailTemplateProps = NewsletterEntityProps | AlertSeriesProps;

/**
 * Template type identifiers.
 */
export type EmailTemplateType = EmailTemplateProps['templateType'];

// ─────────────────────────────────────────────────────────────────────────────
// Rendered Email
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of rendering an email template.
 */
export interface RenderedEmail {
  /** Email subject line */
  subject: string;
  /** HTML content */
  html: string;
  /** Plain text content (for accessibility/fallback) */
  text: string;
  /** Template name that was rendered */
  templateName: string;
  /** Template version */
  templateVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata about a template.
 */
export interface TemplateMetadata {
  /** Template name */
  name: string;
  /** Template version */
  version: string;
  /** Description of the template */
  description: string;
  /** Example props for preview */
  exampleProps: EmailTemplateProps;
}

/**
 * Current template version.
 */
export const TEMPLATE_VERSION = '1.0.0';
