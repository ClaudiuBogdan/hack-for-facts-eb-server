/**
 * Email Template Renderer
 *
 * React Email adapter for rendering templates to HTML and text.
 * Uses the template registry as the single source of truth.
 */

import { render } from '@react-email/render';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ok, err, type Result } from 'neverthrow';

import { BaseTemplatePropsSchema } from '../../core/schemas.js';
import {
  type EmailTemplateProps,
  type EmailTemplateType,
  type RenderedEmail,
  type TemplateMetadata,
} from '../../core/types.js';
import { makeTemplateRegistry } from '../registry/index.js';

import type { EmailRenderer, TemplateError } from '../../core/ports.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the email renderer.
 */
export interface EmailRendererConfig {
  /** Logger instance */
  logger: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an email renderer using React Email.
 */
export const makeEmailRenderer = (config: EmailRendererConfig): EmailRenderer => {
  const { logger } = config;
  const log = logger.child({ component: 'EmailRenderer' });
  const registry = makeTemplateRegistry();

  return {
    async render(props: EmailTemplateProps): Promise<Result<RenderedEmail, TemplateError>> {
      log.debug({ templateType: props.templateType }, 'Rendering email template');

      const { templateType } = props;
      const registration = registry.getShell(templateType);
      if (registration === undefined) {
        return err({
          type: 'TEMPLATE_NOT_FOUND',
          message: `Template '${templateType}' is not registered`,
          templateType,
        });
      }

      // Validate payload against composed schema (base + template-specific)
      const fullSchema = Type.Intersect([
        BaseTemplatePropsSchema,
        registration.payloadSchema,
        Type.Object({ templateType: Type.Literal(templateType) }),
      ]);
      if (!Value.Check(fullSchema, props)) {
        const errors = [...Value.Errors(fullSchema, props)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        return err({
          type: 'VALIDATION_ERROR',
          message: `Payload validation failed: ${errors}`,
          templateType,
        });
      }

      try {
        const element = registration.createElement(props);
        const subject = registration.getSubject(props);

        // Render HTML
        const html = await render(element, { pretty: true });

        // Render plain text
        const text = await render(element, { plainText: true });

        log.info(
          { templateType: props.templateType, htmlLength: html.length, textLength: text.length },
          'Email template rendered successfully'
        );

        return ok({
          subject,
          html,
          text,
          templateName: props.templateType,
          templateVersion: registration.version,
        });
      } catch (error) {
        log.error({ error, templateType: props.templateType }, 'Failed to render email template');

        return err({
          type: 'RENDER_ERROR',
          message: error instanceof Error ? error.message : 'Unknown render error',
          templateType: props.templateType,
        });
      }
    },

    getTemplates(): TemplateMetadata[] {
      return registry.getAllShell().map((r) => ({
        name: r.name,
        version: r.version,
        description: r.description,
        exampleProps: r.exampleProps,
      }));
    },

    getTemplate(type: EmailTemplateType): TemplateMetadata | undefined {
      const r = registry.getShell(type);
      if (r === undefined) return undefined;
      return {
        name: r.name,
        version: r.version,
        description: r.description,
        exampleProps: r.exampleProps,
      };
    },
  };
};
