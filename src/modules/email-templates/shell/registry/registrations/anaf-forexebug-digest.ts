// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getDigestSubject } from '../../../core/i18n.js';
import { AnafForexebugDigestPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type AnafForexebugDigestProps } from '../../../core/types.js';
import { AnafForexebugDigestEmail } from '../../templates/anaf-forexebug-digest.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    anaf_forexebug_digest: AnafForexebugDigestProps;
  }
}

export const registration = defineTemplate({
  id: 'anaf_forexebug_digest',
  name: 'anaf_forexebug_digest',
  version: TEMPLATE_VERSION,
  description: 'ANAF / Forexebug data update digest with reports and alerts',
  payloadSchema: AnafForexebugDigestPayloadSchema,

  createElement(props: AnafForexebugDigestProps) {
    return React.createElement(AnafForexebugDigestEmail, props);
  },

  getSubject(props: AnafForexebugDigestProps) {
    return getDigestSubject(props.lang, props.periodLabel);
  },

  exampleProps: {
    templateType: 'anaf_forexebug_digest',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/unsubscribe/token123',
    preferencesUrl: 'https://transparenta.eu/settings/notifications',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    periodKey: '2026-03',
    periodLabel: 'martie 2026',
    sections: [
      {
        kind: 'newsletter_entity',
        notificationId: 'notification-1',
        notificationType: 'newsletter_entity_monthly',
        entityName: 'Primăria Municipiului București',
        entityCui: '4267117',
        entityType: 'Primărie Municipiu',
        countyName: 'București',
        population: 1883425,
        periodLabel: 'martie 2026',
        summary: {
          totalIncome: '184500000',
          totalExpenses: '121300000',
          budgetBalance: '63200000',
          currency: 'RON',
        },
        monthlyDelta: {
          totalIncome: '184500000',
          totalExpenses: '121300000',
          budgetBalance: '63200000',
          currency: 'RON',
        },
        ytdSummary: {
          totalIncome: '1502800000',
          totalExpenses: '982350000',
          budgetBalance: '520450000',
          currency: 'RON',
        },
        previousPeriodComparison: {
          incomeChangePercent: '8.5',
          expensesChangePercent: '12.3',
          balanceChangePercent: '-4.2',
          balanceChangeAmount: '-22600000',
        },
        topExpenseCategories: [
          { name: 'Transport public', amount: '245600000', percentage: '25.0' },
          { name: 'Învățământ', amount: '196500000', percentage: '20.0' },
          { name: 'Sănătate', amount: '147350000', percentage: '15.0' },
        ],
        detailsUrl:
          'https://transparenta.eu/entities/4267117?period=MONTH&normalization=total&year=2026&month=03',
        mapUrl: 'https://transparenta.eu/map?entity=4267117',
      },
      {
        kind: 'newsletter_entity',
        notificationId: 'notification-3',
        notificationType: 'newsletter_entity_monthly',
        entityName: 'Municipiul Sibiu',
        entityCui: '4240600',
        periodLabel: 'martie 2026',
        summary: {
          totalIncome: '35000000',
          totalExpenses: '21200000',
          budgetBalance: '13800000',
          currency: 'RON',
        },
        monthlyDelta: {
          totalIncome: '35000000',
          totalExpenses: '21200000',
          budgetBalance: '13800000',
          currency: 'RON',
        },
        ytdSummary: {
          totalIncome: '280050000',
          totalExpenses: '182370000',
          budgetBalance: '97680000',
          currency: 'RON',
        },
        detailsUrl:
          'https://transparenta.eu/entities/4240600?period=MONTH&normalization=total&year=2026&month=03',
      },
      {
        kind: 'alert_series',
        notificationId: 'notification-2',
        notificationType: 'alert_series_analytics',
        title: 'Cheltuieli neobișnuite detectate',
        description: 'Au fost detectate cheltuieli care depășesc pragurile normale.',
        actualValue: '1500000',
        unit: 'RON',
        triggeredConditions: [
          {
            operator: 'gt',
            threshold: '1000000',
            actualValue: '1500000',
            unit: 'RON',
          },
        ],
        dataSourceUrl: 'https://transparenta.eu/entities/4267117/analytics',
      },
    ],
  },
});
