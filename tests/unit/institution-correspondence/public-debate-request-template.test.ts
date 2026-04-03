import { describe, expect, it } from 'vitest';

import { makePublicDebateTemplateRenderer } from '@/modules/institution-correspondence/index.js';

describe('makePublicDebateTemplateRenderer', () => {
  it('renders the Funky legal request copy for the budget debate email', () => {
    const renderer = makePublicDebateTemplateRenderer();

    const rendered = renderer.renderPublicDebateRequest({
      entityName: 'COMUNA ION ROATA',
      institutionEmail: 'contact@primarie.ro',
      requesterOrganizationName: 'Asociatia Test',
      ngoIdentity: 'funky_citizens',
      budgetYear: 2026,
      threadKey: 'thread-key-1',
    });

    expect(rendered.subject).toBe('Cerere dezbatere buget local - COMUNA ION ROATA');
    expect(rendered.text.startsWith('Domnule Primar,')).toBe(true);
    expect(rendered.text).not.toContain('Cerere dezbatere buget local\n\nDomnule Primar,');
    expect(rendered.text).toContain('Subscrisa, Funky Citizens');
    expect(rendered.text).toContain('CERERE DE ORGANIZARE A UNEI DEZBATERI');
    expect(rendered.text).toContain('cu privire la proiectul de buget local pentru anul 2026');
    expect(rendered.text).toContain(
      'Vă solicităm organizarea unei dezbateri publice asupra proiectului de buget local pentru anul 2026.'
    );
    expect(rendered.text).toContain('Echipa Funky Citizens');
    expect(rendered.html).toContain('Domnule Primar,');
    expect(rendered.html).toContain('style="margin:0; line-height:1.5;"');
    expect(rendered.html).toContain('style="height:10px; line-height:10px;"');
    expect(rendered.html).toContain('Subscrisa, Funky Citizens');
  });
});
