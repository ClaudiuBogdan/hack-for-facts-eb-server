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

export const PublicDebateEntityUpdateThreadStartedSubscriberPayloadSchema = Type.Object({
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.Optional(Type.String({ minLength: 1 })),
  occurredAt: Type.String({ minLength: 1 }),
  ctaUrl: Type.String({ minLength: 1 }),
});

export type PublicDebateEntityUpdateThreadStartedSubscriberPayload = Static<
  typeof PublicDebateEntityUpdateThreadStartedSubscriberPayloadSchema
>;

const PublicDebateAdminResponsePayloadBaseSchema = Type.Object({
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  responseStatus: Type.Union([
    Type.Literal('registration_number_received'),
    Type.Literal('request_confirmed'),
    Type.Literal('request_denied'),
  ]),
  responseDate: Type.String({ minLength: 1 }),
  messageContent: Type.String({ minLength: 1 }),
  ctaUrl: Type.String({ minLength: 1 }),
});

export const PublicDebateAdminResponseRequesterPayloadSchema =
  PublicDebateAdminResponsePayloadBaseSchema;

export type PublicDebateAdminResponseRequesterPayload = Static<
  typeof PublicDebateAdminResponseRequesterPayloadSchema
>;

export const PublicDebateAdminResponseSubscriberPayloadSchema =
  PublicDebateAdminResponsePayloadBaseSchema;

export type PublicDebateAdminResponseSubscriberPayload = Static<
  typeof PublicDebateAdminResponseSubscriberPayloadSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Public Debate Admin Failure Template
// ─────────────────────────────────────────────────────────────────────────────

export const PublicDebateAdminFailurePayloadSchema = Type.Object({
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.Optional(Type.String({ minLength: 1 })),
  threadId: Type.String({ minLength: 1 }),
  phase: Type.String({ minLength: 1 }),
  institutionEmail: Type.String({ minLength: 1 }),
  subjectLine: Type.String({ minLength: 1 }),
  occurredAt: Type.String({ minLength: 1 }),
  failureMessage: Type.String({ minLength: 1 }),
});

export type PublicDebateAdminFailurePayload = Static<typeof PublicDebateAdminFailurePayloadSchema>;

export const PublicDebateAnnouncementPayloadSchema = Type.Object({
  campaignKey: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  date: Type.String({ minLength: 1 }),
  time: Type.String({ minLength: 1 }),
  location: Type.String({ minLength: 1 }),
  announcementLink: Type.String({ minLength: 1 }),
  onlineParticipationLink: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String({ minLength: 1 })),
  ctaUrl: Type.Optional(Type.String({ minLength: 1 })),
});

export type PublicDebateAnnouncementPayload = Static<typeof PublicDebateAnnouncementPayloadSchema>;

export const AdminReviewedInteractionNextStepLinkSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('retry_interaction'),
    Type.Literal('start_public_debate_request'),
    Type.Literal('view_entity'),
  ]),
  label: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ minLength: 1 })),
});

export const AdminReviewedInteractionPayloadSchema = Type.Object({
  campaignKey: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  interactionId: Type.String({ minLength: 1 }),
  interactionLabel: Type.String({ minLength: 1 }),
  reviewStatus: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
  reviewedAt: Type.String({ minLength: 1 }),
  feedbackText: Type.Optional(Type.String({ minLength: 1 })),
  nextStepLinks: Type.Optional(
    Type.Array(AdminReviewedInteractionNextStepLinkSchema, { minItems: 1 })
  ),
});

export type AdminReviewedInteractionPayload = Static<typeof AdminReviewedInteractionPayloadSchema>;

export const WeeklyProgressDigestStatusToneSchema = Type.Union([
  Type.Literal('danger'),
  Type.Literal('warning'),
  Type.Literal('success'),
]);

export const WeeklyProgressDigestSummarySchema = Type.Object({
  totalItemCount: Type.Integer({ minimum: 0 }),
  visibleItemCount: Type.Integer({ minimum: 0 }),
  hiddenItemCount: Type.Integer({ minimum: 0 }),
  actionNowCount: Type.Integer({ minimum: 0 }),
  approvedCount: Type.Integer({ minimum: 0 }),
  rejectedCount: Type.Integer({ minimum: 0 }),
  pendingCount: Type.Integer({ minimum: 0 }),
  draftCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
});

export const WeeklyProgressDigestItemSchema = Type.Object({
  itemKey: Type.String({ minLength: 1 }),
  interactionId: Type.String({ minLength: 1 }),
  interactionLabel: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  statusLabel: Type.String({ minLength: 1 }),
  statusTone: WeeklyProgressDigestStatusToneSchema,
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  updatedAt: Type.String({ minLength: 1 }),
  reviewedAt: Type.Optional(Type.String({ minLength: 1 })),
  feedbackSnippet: Type.Optional(Type.String({ minLength: 1 })),
  actionLabel: Type.String({ minLength: 1 }),
  actionUrl: Type.String({ minLength: 1 }),
});

export const WeeklyProgressDigestCtaSchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
});

export const WeeklyProgressDigestPayloadSchema = Type.Object({
  campaignKey: Type.Literal('funky'),
  weekKey: Type.String({ minLength: 1 }),
  periodLabel: Type.String({ minLength: 1 }),
  summary: WeeklyProgressDigestSummarySchema,
  items: Type.Array(WeeklyProgressDigestItemSchema),
  primaryCta: WeeklyProgressDigestCtaSchema,
  secondaryCtas: Type.Array(WeeklyProgressDigestCtaSchema, { maxItems: 2 }),
  allUpdatesUrl: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
});

export type WeeklyProgressDigestPayload = Static<typeof WeeklyProgressDigestPayloadSchema>;

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

export const BudgetAmountsSchema = Type.Object({
  totalIncome: DecimalStringSchema,
  totalExpenses: DecimalStringSchema,
  budgetBalance: DecimalStringSchema,
});

export const BudgetSummarySchema = Type.Object({
  totalIncome: DecimalStringSchema,
  totalExpenses: DecimalStringSchema,
  budgetBalance: DecimalStringSchema,
  currency: Type.String({ minLength: 1 }),
});

export const PeriodComparisonSchema = Type.Object({
  incomeChangePercent: Type.Optional(DecimalStringSchema),
  expensesChangePercent: Type.Optional(DecimalStringSchema),
  balanceChangePercent: Type.Optional(DecimalStringSchema),
  balanceChangeAmount: DecimalStringSchema,
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

const NewsletterEntityCommonPayloadSchema = Type.Object({
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

export const NewsletterEntityPayloadSchema = Type.Union([
  Type.Intersect([
    NewsletterEntityCommonPayloadSchema,
    Type.Object({
      periodType: Type.Literal('monthly'),
      monthlyDelta: BudgetSummarySchema,
      ytdSummary: BudgetSummarySchema,
    }),
  ]),
  Type.Intersect([
    NewsletterEntityCommonPayloadSchema,
    Type.Object({
      periodType: Type.Union([Type.Literal('quarterly'), Type.Literal('yearly')]),
      monthlyDelta: Type.Optional(BudgetSummarySchema),
      ytdSummary: Type.Optional(BudgetSummarySchema),
    }),
  ]),
]);

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
  monthlyDelta: BudgetSummarySchema,
  ytdSummary: BudgetSummarySchema,
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
