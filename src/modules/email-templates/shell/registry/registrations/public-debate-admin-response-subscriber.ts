// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { PublicDebateAdminResponseSubscriberPayloadSchema } from '../../../core/schemas.js';
import {
  TEMPLATE_VERSION,
  type PublicDebateAdminResponseSubscriberProps,
} from '../../../core/types.js';
import {
  PublicDebateAdminResponseEmail,
  getPublicDebateAdminResponseSubject,
} from '../../templates/public-debate-admin-response.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_admin_response_subscriber: PublicDebateAdminResponseSubscriberProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_admin_response_subscriber',
  name: 'public_debate_admin_response_subscriber',
  version: TEMPLATE_VERSION,
  description: 'Admin-response notification copy for locality subscribers',
  payloadSchema: PublicDebateAdminResponseSubscriberPayloadSchema,

  createElement(props: PublicDebateAdminResponseSubscriberProps) {
    return React.createElement(PublicDebateAdminResponseEmail, props);
  },

  getSubject(props: PublicDebateAdminResponseSubscriberProps) {
    return getPublicDebateAdminResponseSubject(props);
  },

  exampleProps: {
    templateType: 'public_debate_admin_response_subscriber',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    responseStatus: 'request_confirmed',
    responseDate: '2026-04-16T12:00:00.000Z',
    messageContent: 'Primăria a confirmat că solicitarea este în analiză.',
    ctaUrl: 'https://transparenta.eu/provocare/localitati/12345678',
  } as PublicDebateAdminResponseSubscriberProps,
});
