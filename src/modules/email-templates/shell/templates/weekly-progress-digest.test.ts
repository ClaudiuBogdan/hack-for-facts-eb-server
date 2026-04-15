import { describe, expect, it } from 'vitest';

import { registration as weeklyProgressDigestRegistration } from '../registry/registrations/weekly-progress-digest.js';
import { renderTemplateRegistration } from '../renderer/render-template-registration.js';

import type { WeeklyProgressDigestProps } from '../../core/types.js';

describe('weekly progress digest template', () => {
  it('renders one primary CTA and at most two non-duplicate secondary CTAs', async () => {
    const props: WeeklyProgressDigestProps = {
      ...weeklyProgressDigestRegistration.exampleProps,
      primaryCta: {
        label: 'Continua cererea de dezbatere',
        url: 'https://transparenta.eu/cta/primary',
      },
      secondaryCtas: [
        {
          label: 'Trimite raportul de participare',
          url: 'https://transparenta.eu/cta/report',
        },
        {
          label: 'Trimite raportul de participare',
          url: 'https://transparenta.eu/cta/report',
        },
      ],
    };

    const result = await renderTemplateRegistration(weeklyProgressDigestRegistration, props);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const reportLabelOccurrences =
        result.value.html.match(/Trimite raportul de participare/g) ?? [];
      expect(result.value.subject).toBe('Ai 2 pasi care merita atentie');
      expect(result.value.html).toContain('Continua cererea de dezbatere');
      expect(result.value.html).toContain('Trimite raportul de participare');
      expect(reportLabelOccurrences).toHaveLength(1);
      expect(result.value.text).toContain('Ce poti face mai departe');
    }
  });
});
