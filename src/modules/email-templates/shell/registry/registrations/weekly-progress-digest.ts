// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { WeeklyProgressDigestPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type WeeklyProgressDigestProps } from '../../../core/types.js';
import {
  WeeklyProgressDigestEmail,
  getWeeklyProgressDigestSubject,
} from '../../templates/weekly-progress-digest.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    weekly_progress_digest: WeeklyProgressDigestProps;
  }
}

export const registration = defineTemplate({
  id: 'weekly_progress_digest',
  name: 'weekly_progress_digest',
  version: TEMPLATE_VERSION,
  description: 'Weekly progress digest for the Funky campaign',
  payloadSchema: WeeklyProgressDigestPayloadSchema,

  createElement(props: WeeklyProgressDigestProps) {
    return React.createElement(WeeklyProgressDigestEmail, props);
  },

  getSubject(props: WeeklyProgressDigestProps) {
    return getWeeklyProgressDigestSubject(props);
  },

  exampleProps: {
    templateType: 'weekly_progress_digest',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    campaignKey: 'funky',
    weekKey: '2026-W16',
    periodLabel: '8-14 aprilie',
    summary: {
      totalItemCount: 3,
      visibleItemCount: 3,
      hiddenItemCount: 0,
      actionNowCount: 2,
      approvedCount: 1,
      rejectedCount: 1,
      pendingCount: 1,
      draftCount: 0,
      failedCount: 0,
    },
    items: [
      {
        itemKey: 'item-1',
        interactionId: 'funky:interaction:budget_document',
        interactionLabel: 'Documentul de buget',
        entityName: 'Municipiul Exemplu',
        statusLabel: 'Mai are nevoie de o corectura',
        statusTone: 'danger',
        title: 'Documentul de buget trebuie corectat',
        description: 'Am gasit o problema care te impiedica sa mergi mai departe.',
        updatedAt: '2026-04-15T08:00:00.000Z',
        feedbackSnippet: 'Fisierul trimis nu contine proiectul complet.',
        actionLabel: 'Corecteaza documentul',
        actionUrl: 'https://transparenta.eu/primarie/12345678/provocari/buget/document',
      },
      {
        itemKey: 'item-2',
        interactionId: 'funky:interaction:public_debate_request',
        interactionLabel: 'Cererea de dezbatere publica',
        entityName: 'Municipiul Exemplu',
        statusLabel: 'Este salvat, dar netrimis',
        statusTone: 'warning',
        title: 'Cererea ta asteapta sa fie trimisa',
        description: 'Textul este deja salvat, deci poti continua fara sa o iei de la capat.',
        updatedAt: '2026-04-15T07:00:00.000Z',
        actionLabel: 'Continua cererea de dezbatere',
        actionUrl: 'https://transparenta.eu/primarie/12345678/provocari/buget/cerere',
      },
    ],
    primaryCta: {
      label: 'Continua cererea de dezbatere',
      url: 'https://transparenta.eu/primarie/12345678/provocari/buget/cerere',
    },
    secondaryCtas: [
      {
        label: 'Corecteaza documentul',
        url: 'https://transparenta.eu/primarie/12345678/provocari/buget/document',
      },
      {
        label: 'Trimite raportul de participare',
        url: 'https://transparenta.eu/primarie/12345678/provocari/buget/participare',
      },
    ],
    allUpdatesUrl: null,
  } as WeeklyProgressDigestProps,
});
