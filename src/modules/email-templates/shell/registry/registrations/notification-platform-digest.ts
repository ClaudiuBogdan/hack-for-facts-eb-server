// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { NotificationPlatformDigestPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type NotificationPlatformDigestProps } from '../../../core/types.js';
import {
  getNotificationPlatformDigestSubject,
  NotificationPlatformDigestEmail,
} from '../../templates/notification-platform-digest.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Public template id is pinned by the platform design
    'notification-platform-digest': NotificationPlatformDigestProps;
  }
}

export const registration = defineTemplate({
  id: 'notification-platform-digest',
  name: 'notification-platform-digest',
  version: TEMPLATE_VERSION,
  description: 'Rezumat pentru notificările materializate de platforma unificată',
  payloadSchema: NotificationPlatformDigestPayloadSchema,

  createElement(props: NotificationPlatformDigestProps) {
    return React.createElement(NotificationPlatformDigestEmail, props);
  },

  getSubject() {
    return getNotificationPlatformDigestSubject();
  },

  exampleProps: {
    templateType: 'notification-platform-digest',
    lang: 'ro',
    unsubscribeUrl: 'https://api.transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/settings/notifications',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    items: [
      {
        title: 'A fost publicat un vot nou',
        summary: 'Inițiativa urmărită de tine a fost votată în plen.',
        actionUrl: 'https://transparenta.eu/parlament/initiative/exemplu',
      },
      {
        title: 'Date bugetare actualizate',
        summary: 'Primăria urmărită are un raport lunar nou.',
        actionUrl: null,
      },
    ],
    overflowCount: 3,
    inboxUrl: 'https://transparenta.eu/notifications',
  },
});
