// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getPublicDebateCampaignWelcomeSubject } from '../../../core/i18n.js';
import { PublicDebateCampaignWelcomePayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type PublicDebateCampaignWelcomeProps } from '../../../core/types.js';
import { PublicDebateCampaignWelcomeEmail } from '../../templates/public-debate-campaign-welcome.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_campaign_welcome: PublicDebateCampaignWelcomeProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_campaign_welcome',
  name: 'public_debate_campaign_welcome',
  version: TEMPLATE_VERSION,
  description: 'Campaign welcome email for the first accepted public debate entity',
  payloadSchema: PublicDebateCampaignWelcomePayloadSchema,

  createElement(props: PublicDebateCampaignWelcomeProps) {
    return React.createElement(PublicDebateCampaignWelcomeEmail, props);
  },

  getSubject(props: PublicDebateCampaignWelcomeProps) {
    return getPublicDebateCampaignWelcomeSubject(props.lang);
  },

  exampleProps: {
    templateType: 'public_debate_campaign_welcome',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/settings/notifications',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    campaignKey: 'public_debate',
    entityCui: '12345678',
    entityName: 'Primăria Municipiului Exemplu',
    acceptedTermsAt: '2026-04-01T10:00:00.000Z',
    ctaUrl: 'https://transparenta.eu/entities/12345678',
  } as PublicDebateCampaignWelcomeProps,
});
