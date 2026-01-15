/**
 * Email Templates Module - Ports (Interfaces)
 *
 * Defines interfaces for template rendering.
 */

import type {
  EmailTemplateProps,
  RenderedEmail,
  TemplateMetadata,
  EmailTemplateType,
} from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Template rendering error types.
 */
export type TemplateErrorType = 'TEMPLATE_NOT_FOUND' | 'RENDER_ERROR' | 'VALIDATION_ERROR';

/**
 * Template rendering error.
 */
export interface TemplateError {
  type: TemplateErrorType;
  message: string;
  templateType?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Renderer Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface for rendering email templates.
 */
export interface EmailRenderer {
  /**
   * Renders an email template to HTML and text.
   */
  render(props: EmailTemplateProps): Promise<Result<RenderedEmail, TemplateError>>;

  /**
   * Gets metadata about available templates.
   */
  getTemplates(): TemplateMetadata[];

  /**
   * Gets metadata for a specific template.
   */
  getTemplate(type: EmailTemplateType): TemplateMetadata | undefined;
}
