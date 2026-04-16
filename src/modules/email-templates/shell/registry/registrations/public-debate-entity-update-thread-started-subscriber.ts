// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { PublicDebateEntityUpdateThreadStartedSubscriberPayloadSchema } from '../../../core/schemas.js';
import {
  TEMPLATE_VERSION,
  type PublicDebateEntityUpdateThreadStartedSubscriberProps,
} from '../../../core/types.js';
import {
  PublicDebateEntityUpdateThreadStartedSubscriberEmail,
  getPublicDebateEntityUpdateThreadStartedSubscriberSubject,
} from '../../templates/public-debate-entity-update-thread-started-subscriber.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_entity_update_thread_started_subscriber: PublicDebateEntityUpdateThreadStartedSubscriberProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_entity_update_thread_started_subscriber',
  name: 'public_debate_entity_update_thread_started_subscriber',
  version: TEMPLATE_VERSION,
  description: 'Subscriber public debate thread-started notification',
  payloadSchema: PublicDebateEntityUpdateThreadStartedSubscriberPayloadSchema,

  createElement(props: PublicDebateEntityUpdateThreadStartedSubscriberProps) {
    return React.createElement(PublicDebateEntityUpdateThreadStartedSubscriberEmail, props);
  },

  getSubject(props: PublicDebateEntityUpdateThreadStartedSubscriberProps) {
    return getPublicDebateEntityUpdateThreadStartedSubscriberSubject(props);
  },

  exampleProps: {
    templateType: 'public_debate_entity_update_thread_started_subscriber',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    occurredAt: '2026-04-03T10:00:00.000Z',
    ctaUrl: 'https://transparenta.eu/primarie/12345678',
  } as PublicDebateEntityUpdateThreadStartedSubscriberProps,
});
