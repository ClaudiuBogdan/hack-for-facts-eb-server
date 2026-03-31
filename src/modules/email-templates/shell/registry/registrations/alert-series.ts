/**
 * Alert series email template registration.
 */

// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { getAlertSubject } from '../../../core/i18n.js';
import { AlertSeriesPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type AlertSeriesProps } from '../../../core/types.js';
import { AlertSeriesEmail } from '../../templates/alert-series.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    alert_series: AlertSeriesProps;
  }
}

export const registration = defineTemplate({
  id: 'alert_series',
  name: 'alert_series',
  version: TEMPLATE_VERSION,
  description: 'Alert notification when conditions are triggered',
  payloadSchema: AlertSeriesPayloadSchema,

  createElement(props: AlertSeriesProps) {
    return React.createElement(AlertSeriesEmail, props);
  },

  getSubject(props: AlertSeriesProps) {
    return getAlertSubject(props.lang, props.title);
  },

  exampleProps: {
    templateType: 'alert_series',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/unsubscribe/token123',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
    title: 'Cheltuieli depășite',
    description: 'Cheltuielile lunare au depășit pragul configurat.',
    triggeredConditions: [
      {
        operator: 'gt',
        threshold: '1000000',
        actualValue: '1250000',
        unit: 'RON',
      },
    ],
    dataSourceUrl: 'https://transparenta.eu/data/123',
  } as AlertSeriesProps,
});
