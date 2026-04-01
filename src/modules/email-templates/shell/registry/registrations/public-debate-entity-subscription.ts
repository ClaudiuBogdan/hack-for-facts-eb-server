// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getPublicDebateEntitySubscriptionSubject } from '../../../core/i18n.js';
import { PublicDebateEntitySubscriptionPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type PublicDebateEntitySubscriptionProps } from '../../../core/types.js';
import { PublicDebateEntitySubscriptionEmail } from '../../templates/public-debate-entity-subscription.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_entity_subscription: PublicDebateEntitySubscriptionProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_entity_subscription',
  name: 'public_debate_entity_subscription',
  version: TEMPLATE_VERSION,
  description: 'Confirmation email for additional public debate entity subscriptions',
  payloadSchema: PublicDebateEntitySubscriptionPayloadSchema,

  createElement(props: PublicDebateEntitySubscriptionProps) {
    return React.createElement(PublicDebateEntitySubscriptionEmail, props);
  },

  getSubject(props: PublicDebateEntitySubscriptionProps) {
    return getPublicDebateEntitySubscriptionSubject(props.lang);
  },

  exampleProps: {
    templateType: 'public_debate_entity_subscription',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/settings/notifications',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    campaignKey: 'public_debate',
    entityCui: '87654321',
    entityName: 'Consiliul Județean Exemplu',
    acceptedTermsAt: '2026-04-02T11:00:00.000Z',
    ctaUrl: 'https://transparenta.eu/entities/87654321',
  } as PublicDebateEntitySubscriptionProps,
});
