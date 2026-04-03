import { buildPublicDebateRequestSubject } from '../../core/usecases/helpers.js';

import type { CorrespondenceTemplateRenderer } from '../../core/ports.js';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const PARAGRAPH_STYLE = 'margin:0; line-height:1.5;';
const SPACER_STYLE = 'height:10px; line-height:10px;';

export const makePublicDebateTemplateRenderer = (): CorrespondenceTemplateRenderer => {
  return {
    renderPublicDebateRequest(input) {
      const bodyLines = [
        'Domnule Primar,',
        '',
        'Subscrisa, Funky Citizens, având sediul în Str. Brăilița nr. 7, Sector 3 București, înregistrată în Registrul Asociațiilor și Fundațiilor cu nr. 65 / 22.05.2012, cu CIF RO30339344, prin Elena Calistru, în calitate de Președinte.',
        '',
        'În temeiul art. 7 alin. (9) din Legea nr. 52/2003 și al art. 8 lit. b) și art. 39 alin. (3) din Legea nr. 273/2006,',
        '',
        'Prin prezenta formulăm',
        'CERERE DE ORGANIZARE A UNEI DEZBATERI',
        `cu privire la proiectul de buget local pentru anul ${String(input.budgetYear)}`,
        '',
        'Pentru următoarele motive:',
        '',
        'Membrii comunității locale își doresc o administrație publică deschisă și transparentă, care să mizeze pe implicarea cetățenilor și care să demonstreze constant responsabilitatea față de comunitate. Considerăm că autoritatea publică locală aderă la aceleași principii, de unde și inițiativa de a solicita organizarea de evenimente publice, deschise cetățenilor și societății civile, pentru a dezbate proiecte cu impact asupra comunității.',
        '',
        'Proiectul de buget a fost publicat pe site-ul primăriei, iar cetățenii au posibilitatea de a trimite sesizările, observațiile și punctele de vedere la adresa de corespondență electronică dedicată, însă considerăm că este necesară organizarea unei dezbateri publice pe acest subiect. Ținând cont de faptul că bugetul este fundamental pentru funcționarea comunității, găsim extrem de important ca un proces cât mai amplu de deliberare, cu concursul a cât mai mulți factori sociali, să aibă loc.',
        '',
        'Având în vedere cele expuse anterior, în temeiul:',
        'Art. 8 lit. b) din Legea nr. 273/2006 privind finanțele publice locale, referitor la obligativitatea dezbaterii publice a proiectului de buget local cu prilejul aprobării acestuia;',
        'Art. 39 alin. (3) din aceeași lege, potrivit căruia locuitorii unității administrativ-teritoriale pot depune contestații privind proiectul de buget în termen de 15 zile de la data publicării sau afișării acestuia;',
        'Art. 7 alin. (9) din Legea nr. 52/2003 privind transparența decizională în administrația publică, care prevede obligativitatea organizării unei întâlniri pentru dezbaterea proiectului de act normativ la cererea unei asociații legal constituite;',
        `Vă solicităm organizarea unei dezbateri publice asupra proiectului de buget local pentru anul ${String(input.budgetYear)}. Vă rugăm să organizați dezbaterea înainte de expirarea termenului de 15 zile pentru depunerea contestațiilor, reglementat de art. 39 alin. (3) din Legea nr. 273/2006.`,
        '',
        'Considerăm că accesibilitatea este o prioritate, astfel încât credem că un astfel de eveniment ar trebui organizat în format hibrid, ceea ce permite participarea fizică, dar și online, a celor interesați.',
        '',
        'Vă rugăm așadar să comunicați public data, locul și ora la care urmează a fi organizată dezbaterea, împreună cu detaliile pentru participarea online.',
        '',
        'Cu stimă,',
        'Echipa Funky Citizens',
      ];

      const text = bodyLines.join('\n');
      const html = bodyLines
        .map((line) =>
          line === ''
            ? `<div style="${SPACER_STYLE}"></div>`
            : `<p style="${PARAGRAPH_STYLE}">${escapeHtml(line)}</p>`
        )
        .join('');

      return {
        subject: buildPublicDebateRequestSubject(input.entityName),
        text,
        html,
      };
    },
  };
};
