// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { PublicDebateAdminFailurePayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type PublicDebateAdminFailureProps } from '../../../core/types.js';
import {
  PublicDebateAdminFailureEmail,
  getPublicDebateAdminFailureSubject,
} from '../../templates/public-debate-admin-failure.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    public_debate_admin_failure: PublicDebateAdminFailureProps;
  }
}

export const registration = defineTemplate({
  id: 'public_debate_admin_failure',
  name: 'public_debate_admin_failure',
  version: TEMPLATE_VERSION,
  description: 'Admin-only alert for failed public debate institution sends',
  payloadSchema: PublicDebateAdminFailurePayloadSchema,

  createElement(props: PublicDebateAdminFailureProps) {
    return React.createElement(PublicDebateAdminFailureEmail, props);
  },

  getSubject(props: PublicDebateAdminFailureProps) {
    return getPublicDebateAdminFailureSubject(props);
  },

  exampleProps: {
    templateType: 'public_debate_admin_failure',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    threadId: 'thread-1',
    phase: 'failed',
    institutionEmail: 'contact@primarie.ro',
    subjectLine: 'Cerere dezbatere buget local - Municipiul Exemplu',
    occurredAt: '2026-03-31T10:00:00.000Z',
    failureMessage: 'Provider returned 422 validation_error',
  } as PublicDebateAdminFailureProps,
});
