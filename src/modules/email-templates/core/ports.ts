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
import type { TSchema } from '@sinclair/typebox';
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

// ─────────────────────────────────────────────────────────────────────────────
// Template Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A registered template definition.
 * TPayload is the TypeBox schema type for template-specific props.
 */
export interface TemplateRegistration<
  TType extends EmailTemplateType = EmailTemplateType,
  TPayload extends TSchema = TSchema,
> {
  /** Unique template identifier (e.g., 'welcome', 'alert_series') */
  id: TType;
  /** Human-readable template name */
  name: string;
  /** Template version */
  version: string;
  /** Description of the template */
  description: string;
  /** TypeBox schema for template-specific payload validation */
  payloadSchema: TPayload;
}

/**
 * Registry of available email templates.
 * Single source of truth for template availability and metadata.
 */
export interface TemplateRegistry {
  /** Get a registration by template ID */
  get(id: string): TemplateRegistration | undefined;
  /** Get all registrations */
  getAll(): TemplateRegistration[];
  /** Check if a template ID is registered */
  has(id: string): boolean;
}
