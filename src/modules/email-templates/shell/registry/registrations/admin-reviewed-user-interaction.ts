// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { AdminReviewedInteractionPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type AdminReviewedInteractionProps } from '../../../core/types.js';
import {
  AdminReviewedInteractionEmail,
  getAdminReviewedInteractionSubject,
} from '../../templates/admin-reviewed-user-interaction.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    admin_reviewed_user_interaction: AdminReviewedInteractionProps;
  }
}

export const registration = defineTemplate({
  id: 'admin_reviewed_user_interaction',
  name: 'admin_reviewed_user_interaction',
  version: TEMPLATE_VERSION,
  description: 'Notification sent when a reviewed interaction is approved or rejected',
  payloadSchema: AdminReviewedInteractionPayloadSchema,

  createElement(props: AdminReviewedInteractionProps) {
    return React.createElement(AdminReviewedInteractionEmail, props);
  },

  getSubject(props: AdminReviewedInteractionProps) {
    return getAdminReviewedInteractionSubject(props);
  },

  exampleProps: {
    templateType: 'admin_reviewed_user_interaction',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    campaignKey: 'funky',
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    interactionId: 'funky:interaction:budget_document',
    interactionLabel: 'Document buget',
    reviewStatus: 'rejected',
    reviewedAt: '2026-04-13T12:00:00.000Z',
    feedbackText:
      'Documentul trimis nu este suficient de clar. Incearca din nou cu o versiune mai lizibila.',
    nextStepLinks: [
      {
        kind: 'retry_interaction',
        label: 'Revino la pasul pentru documentul de buget',
        url: 'https://transparenta.eu/primarie/12345678/buget/provocari/civic-campaign/civic-monitor-and-request/03-budget-status-2026',
        description: 'Actualizeaza documentul si retrimite interactiunea.',
      },
    ],
  } as AdminReviewedInteractionProps,
});
