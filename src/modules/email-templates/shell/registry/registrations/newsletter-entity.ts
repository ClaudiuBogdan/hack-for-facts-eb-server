/**
 * Newsletter entity email template registration.
 */

// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getNewsletterSubject } from '../../../core/i18n.js';
import { NewsletterEntityPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type NewsletterEntityProps } from '../../../core/types.js';
import { NewsletterEntityEmail } from '../../templates/newsletter-entity.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    newsletter_entity: NewsletterEntityProps;
  }
}

export const registration = defineTemplate({
  id: 'newsletter_entity',
  name: 'newsletter_entity',
  version: TEMPLATE_VERSION,
  description: 'Entity budget newsletter for monthly, quarterly, or yearly reports',
  payloadSchema: NewsletterEntityPayloadSchema,

  createElement(props: NewsletterEntityProps) {
    return React.createElement(NewsletterEntityEmail, props);
  },

  getSubject(props: NewsletterEntityProps) {
    return getNewsletterSubject(props.lang, props.periodType, props.entityName, props.periodLabel);
  },

  exampleProps: {
    templateType: 'newsletter_entity',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/unsubscribe/token123',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    entityName: 'Primăria București',
    entityCui: '4267117',
    periodType: 'monthly',
    periodLabel: 'Ianuarie 2025',
    summary: {
      totalIncome: '1500000000',
      totalExpenses: '1200000000',
      budgetBalance: '300000000',
      currency: 'RON',
    },
    detailsUrl: 'https://transparenta.eu/entities/4267117',
  },
});
