import { embedThreadKeyInSubject } from '../../core/usecases/helpers.js';

import type { CorrespondenceTemplateRenderer } from '../../core/ports.js';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const getSenderName = (organizationName: string | null, ngoIdentity: string): string => {
  if (organizationName !== null) {
    return organizationName;
  }

  void ngoIdentity;
  return 'Funky Citizens';
};

export const makePublicDebateTemplateRenderer = (): CorrespondenceTemplateRenderer => {
  return {
    renderPublicDebateRequest(input) {
      const sender = getSenderName(input.requesterOrganizationName, input.ngoIdentity);
      const isAssociationRequest = input.requesterOrganizationName !== null;
      const bodyLines = [
        'Stimate Domn Primar / Stimata Doamna Primar,',
        '',
        isAssociationRequest
          ? `${sender}, asociatie legal constituita, va solicitam organizarea unei dezbateri publice asupra proiectului de buget local pentru anul ${String(input.budgetYear)}.`
          : `${sender} va solicita organizarea unei dezbateri publice asupra proiectului de buget local pentru anul ${String(input.budgetYear)} in numele Funky Citizens.`,
        '',
        'Va rugam sa organizati dezbaterea inainte de expirarea termenului de 15 zile pentru depunerea contestatiilor, reglementat de art. 39 alin. (3) din Legea nr. 273/2006.',
        '',
        'Potrivit art. 6 alin. (7) din Legea nr. 52/2003, autoritatea administratiei publice are obligatia de a decide organizarea unei intalniri de dezbatere publica daca acest lucru este cerut in scris de o asociatie legal constituita sau de o alta autoritate publica.',
        '',
        'Va rugam sa ne comunicati data, ora si locul stabilite pentru aceasta dezbatere publica.',
        '',
        'Cu stima,',
        sender,
        '',
        '---',
        'Aceasta solicitare a fost generata cu ajutorul platformei Transparenta.eu',
      ];

      const text = bodyLines.join('\n');
      const html = bodyLines
        .map((line) => (line === '' ? '<br />' : `<p>${escapeHtml(line)}</p>`))
        .join('');

      return {
        subject: embedThreadKeyInSubject(
          `Solicitare organizare dezbatere publica - bugetul local ${String(input.budgetYear)}`,
          input.threadKey
        ),
        text,
        html,
      };
    },
  };
};
