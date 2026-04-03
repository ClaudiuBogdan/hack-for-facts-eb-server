// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { PublicDebateEntityUpdatePayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type PublicDebateEntityUpdateProps } from '../../../core/types.js';
import {
  PublicDebateEntityUpdateEmail,
  getPublicDebateEntityUpdateSubject,
} from '../../templates/public-debate-entity-update.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_entity_update: PublicDebateEntityUpdateProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_entity_update',
  name: 'public_debate_entity_update',
  version: TEMPLATE_VERSION,
  description: 'Event-driven public debate correspondence update notification',
  payloadSchema: PublicDebateEntityUpdatePayloadSchema,

  createElement(props: PublicDebateEntityUpdateProps) {
    return React.createElement(PublicDebateEntityUpdateEmail, props);
  },

  getSubject(props: PublicDebateEntityUpdateProps) {
    return getPublicDebateEntityUpdateSubject(props);
  },

  exampleProps: {
    templateType: 'public_debate_entity_update',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    eventType: 'reply_received',
    campaignKey: 'funky',
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    threadId: 'thread-1',
    threadKey: 'thread-key-1',
    phase: 'reply_received_unreviewed',
    institutionEmail: 'contact@primarie.ro',
    subjectLine: 'Solicitare organizare dezbatere publica - buget local 2026',
    occurredAt: '2026-03-31T10:00:00.000Z',
    replyTextPreview: 'Va comunicam ca solicitarea a fost primita.',
    resolutionCode: 'debate_announced',
    reviewNotes: 'Primaria a confirmat organizarea unei dezbateri.',
  } as PublicDebateEntityUpdateProps,
});
