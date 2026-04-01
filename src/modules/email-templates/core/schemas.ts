/**
 * Email Templates Module - TypeBox Schemas
 *
 * Runtime validation schemas for email template payloads.
 */

import { Type, type Static } from '@sinclair/typebox';

// ─────────────────────────────────────────────────────────────────────────────
// Base Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for supported languages.
 */
export const SupportedLanguageSchema = Type.Union([Type.Literal('ro'), Type.Literal('en')]);

/**
 * Schema for decimal values passed through render-safe DTOs.
 */
export const DecimalStringSchema = Type.String({
  minLength: 1,
  pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$',
});

/**
 * Schema for fields common to all email templates.
 */
export const BaseTemplatePropsSchema = Type.Object({
  lang: SupportedLanguageSchema,
  unsubscribeUrl: Type.String({ minLength: 1 }),
  preferencesUrl: Type.Optional(Type.String()),
  platformBaseUrl: Type.String({ minLength: 1 }),
  copyrightYear: Type.Integer({ minimum: 1970 }),
  isPreview: Type.Optional(Type.Boolean()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Welcome Template
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for welcome email template-specific payload.
 */
export const WelcomePayloadSchema = Type.Object({
  registeredAt: Type.String({ minLength: 1 }),
  ctaUrl: Type.Optional(Type.String()),
});

/**
 * Welcome template payload type (template-specific fields only).
 */
export type WelcomePayload = Static<typeof WelcomePayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Public Debate Campaign Welcome Template
// ─────────────────────────────────────────────────────────────────────────────

export const PublicDebateCampaignWelcomePayloadSchema = Type.Object({
  campaignKey: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  acceptedTermsAt: Type.String({ minLength: 1 }),
  ctaUrl: Type.Optional(Type.String()),
});

export type PublicDebateCampaignWelcomePayload = Static<
  typeof PublicDebateCampaignWelcomePayloadSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Public Debate Entity Subscription Template
// ─────────────────────────────────────────────────────────────────────────────

export const PublicDebateEntitySubscriptionPayloadSchema = Type.Object({
  campaignKey: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  acceptedTermsAt: Type.String({ minLength: 1 }),
  selectedEntities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  ctaUrl: Type.Optional(Type.String()),
});

export type PublicDebateEntitySubscriptionPayload = Static<
  typeof PublicDebateEntitySubscriptionPayloadSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Public Debate Entity Update Template
// ─────────────────────────────────────────────────────────────────────────────

export const PublicDebateEntityUpdatePayloadSchema = Type.Object({
  eventType: Type.Union([
    Type.Literal('thread_started'),
    Type.Literal('thread_failed'),
    Type.Literal('reply_received'),
    Type.Literal('reply_reviewed'),
  ]),
  campaignKey: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.Optional(Type.String({ minLength: 1 })),
  threadId: Type.String({ minLength: 1 }),
  threadKey: Type.String({ minLength: 1 }),
  phase: Type.String({ minLength: 1 }),
  institutionEmail: Type.String({ minLength: 1 }),
  subjectLine: Type.String({ minLength: 1 }),
  occurredAt: Type.String({ minLength: 1 }),
  replyTextPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resolutionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reviewNotes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type PublicDebateEntityUpdatePayload = Static<typeof PublicDebateEntityUpdatePayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Alert Series Template
// ─────────────────────────────────────────────────────────────────────────────

export const TriggeredConditionSchema = Type.Object({
  operator: Type.Union([
    Type.Literal('gt'),
    Type.Literal('gte'),
    Type.Literal('lt'),
    Type.Literal('lte'),
    Type.Literal('eq'),
  ]),
  threshold: DecimalStringSchema,
  actualValue: DecimalStringSchema,
  unit: Type.String({ minLength: 1 }),
});

export const AlertSeriesPayloadSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  triggeredConditions: Type.Array(TriggeredConditionSchema, { minItems: 1 }),
  dataSourceUrl: Type.Optional(Type.String()),
});

export type AlertSeriesPayload = Static<typeof AlertSeriesPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Newsletter Entity Template
// ─────────────────────────────────────────────────────────────────────────────

export const BudgetSummarySchema = Type.Object({
  totalIncome: DecimalStringSchema,
  totalExpenses: DecimalStringSchema,
  budgetBalance: DecimalStringSchema,
  currency: Type.String({ minLength: 1 }),
});

export const PeriodComparisonSchema = Type.Object({
  incomeChangePercent: DecimalStringSchema,
  expensesChangePercent: DecimalStringSchema,
  balanceChangePercent: DecimalStringSchema,
});

export const TopExpenseCategorySchema = Type.Object({
  name: Type.String(),
  amount: DecimalStringSchema,
  percentage: DecimalStringSchema,
});

export const FundingSourceBreakdownSchema = Type.Object({
  name: Type.String(),
  percentage: DecimalStringSchema,
});

export const PerCapitaMetricsSchema = Type.Object({
  income: DecimalStringSchema,
  expenses: DecimalStringSchema,
});

export const NewsletterEntityPayloadSchema = Type.Object({
  entityName: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityType: Type.Optional(Type.String()),
  countyName: Type.Optional(Type.String()),
  population: Type.Optional(Type.Integer()),
  periodType: Type.Union([
    Type.Literal('monthly'),
    Type.Literal('quarterly'),
    Type.Literal('yearly'),
  ]),
  periodLabel: Type.String({ minLength: 1 }),
  summary: BudgetSummarySchema,
  previousPeriodComparison: Type.Optional(PeriodComparisonSchema),
  topExpenseCategories: Type.Optional(Type.Array(TopExpenseCategorySchema)),
  fundingSources: Type.Optional(Type.Array(FundingSourceBreakdownSchema)),
  perCapita: Type.Optional(PerCapitaMetricsSchema),
  detailsUrl: Type.Optional(Type.String()),
  mapUrl: Type.Optional(Type.String()),
});

export type NewsletterEntityPayload = Static<typeof NewsletterEntityPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const AnafForexebugDigestNewsletterSectionSchema = Type.Object({
  kind: Type.Literal('newsletter_entity'),
  notificationId: Type.String({ minLength: 1 }),
  notificationType: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityType: Type.Optional(Type.String()),
  countyName: Type.Optional(Type.String()),
  population: Type.Optional(Type.Integer()),
  periodLabel: Type.String({ minLength: 1 }),
  summary: BudgetSummarySchema,
  previousPeriodComparison: Type.Optional(PeriodComparisonSchema),
  topExpenseCategories: Type.Optional(Type.Array(TopExpenseCategorySchema)),
  fundingSources: Type.Optional(Type.Array(FundingSourceBreakdownSchema)),
  perCapita: Type.Optional(PerCapitaMetricsSchema),
  detailsUrl: Type.Optional(Type.String()),
  mapUrl: Type.Optional(Type.String()),
});

export const AnafForexebugDigestAlertSectionSchema = Type.Object({
  kind: Type.Literal('alert_series'),
  notificationId: Type.String({ minLength: 1 }),
  notificationType: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  actualValue: DecimalStringSchema,
  unit: Type.String({ minLength: 1 }),
  triggeredConditions: Type.Array(TriggeredConditionSchema),
  dataSourceUrl: Type.Optional(Type.String()),
});

export const AnafForexebugDigestPayloadSchema = Type.Object({
  periodKey: Type.String({ minLength: 1 }),
  periodLabel: Type.String({ minLength: 1 }),
  sections: Type.Array(
    Type.Union([AnafForexebugDigestNewsletterSectionSchema, AnafForexebugDigestAlertSectionSchema]),
    { minItems: 1 }
  ),
});

export type AnafForexebugDigestPayload = Static<typeof AnafForexebugDigestPayloadSchema>;
