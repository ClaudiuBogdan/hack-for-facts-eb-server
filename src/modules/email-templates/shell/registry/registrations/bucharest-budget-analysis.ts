// eslint-disable-next-line @typescript-eslint/naming-convention -- React is a third-party naming standard
import * as React from 'react';

import { BucharestBudgetAnalysisPayloadSchema } from '../../../core/schemas.js';
import { TEMPLATE_VERSION, type BucharestBudgetAnalysisProps } from '../../../core/types.js';
import {
  BucharestBudgetAnalysisEmail,
  getBucharestBudgetAnalysisSubject,
} from '../../templates/bucharest-budget-analysis.js';
import { defineTemplate } from '../types.js';

declare module '../../../core/types.js' {
  interface EmailTemplateMap {
    bucharest_budget_analysis_2026_04_23: BucharestBudgetAnalysisProps;
  }
}

export const registration = defineTemplate({
  id: 'bucharest_budget_analysis_2026_04_23',
  name: 'bucharest_budget_analysis_2026_04_23',
  version: TEMPLATE_VERSION,
  description: 'Bucharest-only notification for the Funky PMB 2026 budget analysis',
  payloadSchema: BucharestBudgetAnalysisPayloadSchema,

  createElement(props: BucharestBudgetAnalysisProps) {
    return React.createElement(BucharestBudgetAnalysisEmail, props);
  },

  getSubject(props: BucharestBudgetAnalysisProps) {
    return getBucharestBudgetAnalysisSubject(props);
  },

  exampleProps: {
    templateType: 'bucharest_budget_analysis_2026_04_23',
    lang: 'ro',
    unsubscribeUrl: 'https://transparenta.eu/api/v1/notifications/unsubscribe/example-token',
    preferencesUrl: 'https://transparenta.eu/provocare/notificari',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2026,
  },
});
