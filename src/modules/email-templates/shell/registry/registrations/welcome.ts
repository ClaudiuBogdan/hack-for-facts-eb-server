/**
 * Welcome email template registration.
 */

// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getWelcomeSubject } from '../../../core/i18n.js';
import { WelcomePayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type WelcomeEmailProps } from '../../../core/types.js';
import { WelcomeEmail } from '../../templates/welcome.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    welcome: WelcomeEmailProps;
  }
}

export const registration = defineTemplate({
  id: 'welcome',
  name: 'welcome',
  version: TEMPLATE_VERSION,
  description: 'Transactional welcome email for newly registered users',
  payloadSchema: WelcomePayloadSchema,

  createElement(props: WelcomeEmailProps) {
    return React.createElement(WelcomeEmail, props);
  },

  getSubject(props: WelcomeEmailProps) {
    return getWelcomeSubject(props.lang);
  },

  exampleProps: {
    templateType: 'welcome',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/settings/notifications',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    registeredAt: '2026-03-28T15:00:00.000Z',
    ctaUrl: 'https://transparenta.eu',
  },
});
