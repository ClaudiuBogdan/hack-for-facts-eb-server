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

/**
 * Canonical decimal string representation used for financial values in templates.
 */
export type DecimalString = string;

/**
 * Open map of template ids to full template props.
 *
 * Registration modules augment this interface so the type system derives
 * template ids and template prop unions from the same source as the runtime
 * registry.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Open interface for module augmentation by registration files
export interface EmailTemplateMap {}

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
  /** Explicit year used in footer copy for deterministic rendering */
  copyrightYear: number;
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
 * Budget amount data for newsletter.
 */
export interface BudgetAmounts {
  /** Total income for the period */
  totalIncome: DecimalString;
  /** Total expenses for the period */
  totalExpenses: DecimalString;
  /** Budget balance (income - expenses) */
  budgetBalance: DecimalString;
}

/**
 * Budget summary data for newsletter.
 */
export interface BudgetSummary extends BudgetAmounts {
  /** Currency code (e.g., 'RON') */
  currency: string;
}

/**
 * Period-over-period comparison data.
 */
export interface PeriodComparison {
  /** Income change percentage vs previous period */
  incomeChangePercent?: DecimalString;
  /** Expenses change percentage vs previous period */
  expensesChangePercent?: DecimalString;
  /** Balance change percentage vs previous period */
  balanceChangePercent?: DecimalString;
  /** Absolute balance movement vs previous period */
  balanceChangeAmount: DecimalString;
}

/**
 * Top expense category data.
 */
export interface TopExpenseCategory {
  /** Category name (e.g., "Învățământ") */
  name: string;
  /** Amount spent in this category */
  amount: DecimalString;
  /** Percentage of total expenses */
  percentage: DecimalString;
}

/**
 * Funding source breakdown data.
 */
export interface FundingSourceBreakdown {
  /** Funding source name (e.g., "Buget local") */
  name: string;
  /** Percentage of total funding */
  percentage: DecimalString;
}

/**
 * Per capita metrics for UATs.
 */
export interface PerCapitaMetrics {
  /** Income per capita */
  income: DecimalString;
  /** Expenses per capita */
  expenses: DecimalString;
}

/**
 * Shared props for entity newsletter templates.
 */
export interface NewsletterEntityBaseProps extends BaseTemplateProps {
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

export interface NewsletterEntityMonthlyProps extends NewsletterEntityBaseProps {
  /** Newsletter period type */
  periodType: 'monthly';
  /** Monthly movement for monthly newsletters */
  monthlyDelta: BudgetSummary;
  /** Year-to-date totals through the selected month */
  ytdSummary: BudgetSummary;
}

export interface NewsletterEntityAggregateProps extends NewsletterEntityBaseProps {
  /** Newsletter period type */
  periodType: Exclude<NewsletterPeriodType, 'monthly'>;
  monthlyDelta?: BudgetSummary;
  ytdSummary?: BudgetSummary;
}

/**
 * Props for entity newsletter templates.
 */
export type NewsletterEntityProps = NewsletterEntityMonthlyProps | NewsletterEntityAggregateProps;

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
  threshold: DecimalString;
  /** Actual value that triggered the alert */
  actualValue: DecimalString;
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

/**
 * Props for welcome email templates.
 */
export interface WelcomeEmailProps extends BaseTemplateProps {
  templateType: 'welcome';
  registeredAt: string;
  ctaUrl?: string;
}

/**
 * Props for the first public debate campaign registration email.
 */
export interface PublicDebateCampaignWelcomeProps extends BaseTemplateProps {
  templateType: 'public_debate_campaign_welcome';
  campaignKey: string;
  entityCui: string;
  entityName: string;
  acceptedTermsAt: string;
  ctaUrl?: string;
}

/**
 * Props for public debate entity subscription confirmation emails.
 */
export interface PublicDebateEntitySubscriptionProps extends BaseTemplateProps {
  templateType: 'public_debate_entity_subscription';
  campaignKey: string;
  entityCui: string;
  entityName: string;
  acceptedTermsAt: string;
  selectedEntities?: string[];
  ctaUrl?: string;
}

/**
 * Props for public debate entity update notifications.
 */
export interface PublicDebateEntityUpdateProps extends BaseTemplateProps {
  templateType: 'public_debate_entity_update';
  eventType: 'thread_started' | 'thread_failed' | 'reply_received' | 'reply_reviewed';
  campaignKey: string;
  entityCui: string;
  entityName?: string;
  threadId: string;
  threadKey: string;
  phase: string;
  institutionEmail: string;
  subjectLine: string;
  occurredAt: string;
  replyTextPreview?: string | null;
  resolutionCode?: string | null;
  reviewNotes?: string | null;
}

/**
 * Props for subscriber public debate thread-started notifications.
 */
export interface PublicDebateEntityUpdateThreadStartedSubscriberProps extends BaseTemplateProps {
  templateType: 'public_debate_entity_update_thread_started_subscriber';
  entityCui: string;
  entityName?: string;
  occurredAt: string;
  ctaUrl: string;
}

interface PublicDebateAdminResponseBaseProps extends BaseTemplateProps {
  entityCui: string;
  entityName: string;
  responseStatus: 'registration_number_received' | 'request_confirmed' | 'request_denied';
  responseDate: string;
  messageContent: string;
  ctaUrl: string;
}

export interface PublicDebateAdminResponseRequesterProps extends PublicDebateAdminResponseBaseProps {
  templateType: 'public_debate_admin_response_requester';
}

export interface PublicDebateAdminResponseSubscriberProps extends PublicDebateAdminResponseBaseProps {
  templateType: 'public_debate_admin_response_subscriber';
}

/**
 * Props for admin-only public debate failure alerts.
 */
export interface PublicDebateAdminFailureProps extends BaseTemplateProps {
  templateType: 'public_debate_admin_failure';
  entityCui: string;
  entityName?: string;
  threadId: string;
  phase: string;
  institutionEmail: string;
  subjectLine: string;
  occurredAt: string;
  failureMessage: string;
}

export interface PublicDebateAnnouncementProps extends BaseTemplateProps {
  templateType: 'public_debate_announcement';
  campaignKey: string;
  entityCui: string;
  entityName: string;
  date: string;
  time: string;
  location: string;
  announcementLink: string;
  onlineParticipationLink?: string;
  description?: string;
  ctaUrl?: string;
}

export interface BucharestBudgetAnalysisProps extends BaseTemplateProps {
  templateType: 'bucharest_budget_analysis_2026_04_23';
}

export interface AdminReviewedInteractionNextStepLink {
  kind: 'retry_interaction' | 'start_public_debate_request' | 'view_entity';
  label: string;
  url: string;
  description?: string;
}

/**
 * Props for reviewed interaction outcome notifications.
 */
export interface AdminReviewedInteractionProps extends BaseTemplateProps {
  templateType: 'admin_reviewed_user_interaction';
  campaignKey: string;
  entityCui: string;
  entityName: string;
  interactionId: string;
  interactionLabel: string;
  reviewStatus: 'approved' | 'rejected';
  reviewedAt: string;
  feedbackText?: string;
  nextStepLinks?: AdminReviewedInteractionNextStepLink[];
}

export type WeeklyProgressDigestStatusTone = 'danger' | 'warning' | 'success';

export interface WeeklyProgressDigestSummary {
  totalItemCount: number;
  visibleItemCount: number;
  hiddenItemCount: number;
  actionNowCount: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  draftCount: number;
  failedCount: number;
}

export interface WeeklyProgressDigestItem {
  itemKey: string;
  interactionId: string;
  interactionLabel: string;
  entityName: string;
  statusLabel: string;
  statusTone: WeeklyProgressDigestStatusTone;
  title: string;
  description: string;
  updatedAt: string;
  reviewedAt?: string;
  feedbackSnippet?: string;
  actionLabel: string;
  actionUrl: string;
}

export interface WeeklyProgressDigestCta {
  label: string;
  url: string;
}

export interface WeeklyProgressDigestProps extends BaseTemplateProps {
  templateType: 'weekly_progress_digest';
  campaignKey: 'funky';
  weekKey: string;
  periodLabel: string;
  summary: WeeklyProgressDigestSummary;
  items: WeeklyProgressDigestItem[];
  primaryCta: WeeklyProgressDigestCta;
  secondaryCtas: WeeklyProgressDigestCta[];
  allUpdatesUrl?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Template Props
// ─────────────────────────────────────────────────────────────────────────────

export interface AnafForexebugDigestNewsletterSection {
  kind: 'newsletter_entity';
  notificationId: string;
  notificationType: string;
  entityName: string;
  entityCui: string;
  entityType?: string;
  countyName?: string;
  population?: number;
  periodLabel: string;
  summary: BudgetSummary;
  monthlyDelta: BudgetSummary;
  ytdSummary: BudgetSummary;
  previousPeriodComparison?: PeriodComparison;
  topExpenseCategories?: TopExpenseCategory[];
  fundingSources?: FundingSourceBreakdown[];
  perCapita?: PerCapitaMetrics;
  detailsUrl?: string;
  mapUrl?: string;
}

export interface AnafForexebugDigestAlertSection {
  kind: 'alert_series';
  notificationId: string;
  notificationType: string;
  title: string;
  description?: string;
  /** Current monitored value for the period */
  actualValue: DecimalString;
  /** Unit for the monitored value */
  unit: string;
  /** Triggered conditions (empty when monitoring only, no conditions met) */
  triggeredConditions: TriggeredCondition[];
  dataSourceUrl?: string;
}

export type AnafForexebugDigestSection =
  | AnafForexebugDigestNewsletterSection
  | AnafForexebugDigestAlertSection;

export interface AnafForexebugDigestProps extends BaseTemplateProps {
  templateType: 'anaf_forexebug_digest';
  periodKey: string;
  periodLabel: string;
  sections: AnafForexebugDigestSection[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Union Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible email template props.
 */
export type EmailTemplateProps = EmailTemplateMap[EmailTemplateType];

/**
 * Template type identifiers.
 */
export type EmailTemplateType = keyof EmailTemplateMap;

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
  /**
   * Example props for rendering a preview of this template.
   * Retrieve via `renderer.getTemplate(type)`, then pass to `renderer.render()`
   * to produce a full HTML preview without needing real data.
   */
  exampleProps: EmailTemplateProps;
}

/**
 * Current template version.
 */
export const TEMPLATE_VERSION = '1.0.0';
