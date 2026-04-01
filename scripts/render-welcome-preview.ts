import { writeFileSync } from 'fs';

import { render } from '@react-email/render';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React
import * as React from 'react';

import { WelcomeEmail } from '../src/modules/email-templates/shell/templates/welcome.js';

const main = async () => {
  const element = React.createElement(WelcomeEmail, {
    templateType: 'welcome' as const,
    lang: 'ro' as const,
    unsubscribeUrl: 'https://transparenta.eu/unsubscribe',
    preferencesUrl: 'https://transparenta.eu/preferences',
    platformBaseUrl: 'https://transparenta.eu',
    copyrightYear: 2025,
    registeredAt: new Date().toISOString(),
  });

  const html = await render(element, { pretty: true });
  writeFileSync('/tmp/welcome-email.html', html);
  console.log('Saved to /tmp/welcome-email.html');
};

void main();
