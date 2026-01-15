/**
 * Email Template Renderer
 *
 * React Email adapter for rendering templates to HTML and text.
 */

import { render } from '@react-email/render';
import { ok, err, type Result } from 'neverthrow';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getNewsletterSubject, getAlertSubject } from '../../core/i18n.js';
import {
  TEMPLATE_VERSION,
  type EmailTemplateProps,
  type RenderedEmail,
  type TemplateMetadata,
  type EmailTemplateType,
  type NewsletterEntityProps,
  type AlertSeriesProps,
} from '../../core/types.js';
import { AlertSeriesEmail } from '../templates/alert-series.js';
import { NewsletterEntityEmail } from '../templates/newsletter-entity.js';

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
// Template Metadata
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES: TemplateMetadata[] = [
  {
    name: 'newsletter_entity',
    version: TEMPLATE_VERSION,
    description: 'Entity budget newsletter for monthly, quarterly, or yearly reports',
    exampleProps: {
      templateType: 'newsletter_entity',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsubscribe/token123',
      platformBaseUrl: 'https://transparenta.eu',
      entityName: 'Primăria București',
      entityCui: '4267117',
      periodType: 'monthly',
      periodLabel: 'Ianuarie 2025',
      summary: {
        totalIncome: 1500000000,
        totalExpenses: 1200000000,
        budgetBalance: 300000000,
        currency: 'RON',
      },
      detailsUrl: 'https://transparenta.eu/entities/4267117',
    } as NewsletterEntityProps,
  },
  {
    name: 'alert_series',
    version: TEMPLATE_VERSION,
    description: 'Alert notification when conditions are triggered',
    exampleProps: {
      templateType: 'alert_series',
      lang: 'ro',
      unsubscribeUrl: 'https://transparenta.eu/unsubscribe/token123',
      platformBaseUrl: 'https://transparenta.eu',
      title: 'Cheltuieli depășite',
      description: 'Cheltuielile lunare au depășit pragul configurat.',
      triggeredConditions: [
        {
          operator: 'gt',
          threshold: 1000000,
          actualValue: 1250000,
          unit: 'RON',
        },
      ],
      dataSourceUrl: 'https://transparenta.eu/data/123',
    } as AlertSeriesProps,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the subject line for a template.
 */
function getSubject(props: EmailTemplateProps): string {
  switch (props.templateType) {
    case 'newsletter_entity':
      return getNewsletterSubject(
        props.lang,
        props.periodType,
        props.entityName,
        props.periodLabel
      );
    case 'alert_series':
      return getAlertSubject(props.lang, props.title);
  }
}

/**
 * Creates the React element for a template.
 */
function createTemplateElement(props: EmailTemplateProps): React.ReactElement {
  switch (props.templateType) {
    case 'newsletter_entity':
      return React.createElement(NewsletterEntityEmail, props);
    case 'alert_series':
      return React.createElement(AlertSeriesEmail, props);
  }
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

  return {
    async render(props: EmailTemplateProps): Promise<Result<RenderedEmail, TemplateError>> {
      log.debug({ templateType: props.templateType }, 'Rendering email template');

      try {
        const element = createTemplateElement(props);
        const subject = getSubject(props);

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
          templateVersion: TEMPLATE_VERSION,
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
      return TEMPLATES;
    },

    getTemplate(type: EmailTemplateType): TemplateMetadata | undefined {
      return TEMPLATES.find((t) => t.name === type);
    },
  };
};
