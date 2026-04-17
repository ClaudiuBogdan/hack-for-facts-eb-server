// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { PublicDebateAdminResponseRequesterPayloadSchema } from '../../../core/schemas.js';
import {
  TEMPLATE_VERSION,
  type PublicDebateAdminResponseRequesterProps,
} from '../../../core/types.js';
import {
  PublicDebateAdminResponseEmail,
  getPublicDebateAdminResponseSubject,
} from '../../templates/public-debate-admin-response.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_admin_response_requester: PublicDebateAdminResponseRequesterProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_admin_response_requester',
  name: 'public_debate_admin_response_requester',
  version: TEMPLATE_VERSION,
  description: 'Admin-response notification copy for the request owner',
  payloadSchema: PublicDebateAdminResponseRequesterPayloadSchema,

  createElement(props: PublicDebateAdminResponseRequesterProps) {
    return React.createElement(PublicDebateAdminResponseEmail, props);
  },

  getSubject(props: PublicDebateAdminResponseRequesterProps) {
    return getPublicDebateAdminResponseSubject(props);
  },

  exampleProps: {
    templateType: 'public_debate_admin_response_requester',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    responseStatus: 'registration_number_received',
    responseDate: '2026-04-16T12:00:00.000Z',
    messageContent: 'Am înregistrat solicitarea și revenim cu detalii.',
    ctaUrl: 'https://transparenta.eu/provocare/localitati/12345678',
  } as PublicDebateAdminResponseRequesterProps,
});
