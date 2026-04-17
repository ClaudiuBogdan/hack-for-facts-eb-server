/**
 * Email Templates Module
 *
 * Provides email template rendering using React Email.
 */

// Core types
export type {
  SupportedLanguage,
  BaseTemplateProps,
  DecimalString,
  EmailTemplateMap,
  NewsletterEntityProps,
  AlertSeriesProps,
  WelcomeEmailProps,
  PublicDebateEntityUpdateProps,
  PublicDebateAdminResponseRequesterProps,
  PublicDebateAdminResponseSubscriberProps,
  AdminReviewedInteractionProps,
  WeeklyProgressDigestStatusTone,
  WeeklyProgressDigestSummary,
  WeeklyProgressDigestItem,
  WeeklyProgressDigestCta,
  WeeklyProgressDigestProps,
  AnafForexebugDigestSection,
  AnafForexebugDigestProps,
  EmailTemplateProps,
  EmailTemplateType,
  RenderedEmail,
  TemplateMetadata,
  NewsletterPeriodType,
  BudgetSummary,
  AlertOperator,
  TriggeredCondition,
} from './core/types.js';

export { DEFAULT_LANGUAGE, TEMPLATE_VERSION } from './core/types.js';

// Core schemas
export {
  BaseTemplatePropsSchema,
  SupportedLanguageSchema,
  DecimalStringSchema,
  WelcomePayloadSchema,
  PublicDebateEntityUpdatePayloadSchema,
  PublicDebateAdminResponseRequesterPayloadSchema,
  PublicDebateAdminResponseSubscriberPayloadSchema,
  AdminReviewedInteractionPayloadSchema,
  WeeklyProgressDigestSummarySchema,
  WeeklyProgressDigestItemSchema,
  WeeklyProgressDigestCtaSchema,
  WeeklyProgressDigestPayloadSchema,
  AnafForexebugDigestPayloadSchema,
} from './core/schemas.js';
export type {
  WelcomePayload,
  PublicDebateEntityUpdatePayload,
  PublicDebateAdminResponseRequesterPayload,
  PublicDebateAdminResponseSubscriberPayload,
  AdminReviewedInteractionPayload,
  WeeklyProgressDigestPayload,
  AnafForexebugDigestPayload,
} from './core/schemas.js';

// Core ports
export type {
  EmailRenderer,
  TemplateError,
  TemplateErrorType,
  TemplateRegistration,
  TemplateRegistry,
} from './core/ports.js';

// i18n
export {
  getTranslations,
  interpolate,
  getNewsletterSubject,
  getNewsletterIntro,
  getAlertSubject,
  getWelcomeSubject,
  getOperatorLabel,
} from './core/i18n.js';

// Shell - Renderer
export { makeEmailRenderer } from './shell/renderer/index.js';
export type { EmailRendererConfig } from './shell/renderer/index.js';

// Shell - Registry
export { makeTemplateRegistry } from './shell/registry/index.js';
export type { ShellTemplateRegistry } from './shell/registry/index.js';
