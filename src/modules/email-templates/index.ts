/**
 * Email Templates Module
 *
 * Provides email template rendering using React Email.
 */

// Core types
export type {
  SupportedLanguage,
  BaseTemplateProps,
  NewsletterEntityProps,
  AlertSeriesProps,
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

// Core ports
export type { EmailRenderer, TemplateError, TemplateErrorType } from './core/ports.js';

// i18n
export {
  getTranslations,
  interpolate,
  getNewsletterSubject,
  getNewsletterIntro,
  getAlertSubject,
  getOperatorLabel,
} from './core/i18n.js';

// Shell - Renderer
export { makeEmailRenderer } from './shell/renderer/index.js';
export type { EmailRendererConfig } from './shell/renderer/index.js';
