// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { PublicDebateAnnouncementPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type PublicDebateAnnouncementProps } from '../../../core/types.js';
import {
  getPublicDebateAnnouncementSubject,
  PublicDebateAnnouncementEmail,
} from '../../templates/public-debate-announcement.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_announcement: PublicDebateAnnouncementProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_announcement',
  name: 'public_debate_announcement',
  version: TEMPLATE_VERSION,
  description: 'Config-driven public debate announcement notification',
  payloadSchema: PublicDebateAnnouncementPayloadSchema,

  createElement(props: PublicDebateAnnouncementProps) {
    return React.createElement(PublicDebateAnnouncementEmail, props);
  },

  getSubject(props: PublicDebateAnnouncementProps) {
    return getPublicDebateAnnouncementSubject(props);
  },

  exampleProps: {
    templateType: 'public_debate_announcement',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    campaignKey: 'funky',
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    date: '2026-05-10',
    time: '18:00',
    location: 'Sala de consiliu, Primaria Exemplu',
    announcementLink: 'https://example.com/public-debate',
    onlineParticipationLink: 'https://example.com/public-debate/live',
    description: 'Dezbatere publica privind proiectul de buget local.',
    ctaUrl: 'https://transparenta.eu/primarie/12345678',
  },
});
