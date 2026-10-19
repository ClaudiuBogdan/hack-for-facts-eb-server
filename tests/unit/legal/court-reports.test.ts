/**
 * I-28: the court predicate the API timeline shares with the scrapper's status
 * stage (`src/sources/portal-legislativ/prod/status.ts`, `courtRole`). Issuer
 * slugs as stored in production.
 */
import { describe, expect, it } from 'vitest';

import { courtRole, isCourtReport } from '@/modules/legal/core/court-reports.js';

const act = (issuerSlug: string | null, actType = 'decizie') => ({ actType, issuerSlug });

describe('courtRole', () => {
  it.each([
    ['curtea-constitutionala', 'decizie', 'judicial'],
    [
      'inalta-curte-de-casatie-si-justitie-completul-pentru-dezlegarea-unor-chestiuni-de-drept',
      'decizie',
      'judicial',
    ],
    ['curtea-suprema-de-justitie', 'decizie', 'judicial'],
    ['curtea-de-apel-cluj', 'decizie', 'judicial'],
    ['tribunalul-bucuresti', 'sentinta', 'judicial'],
    ['judecatoria-sectorului-1-bucuresti', 'sentinta', 'judicial'],
    // The ECtHR's hotarare is its judgment.
    ['curtea-europeana-a-drepturilor-omului', 'hotarare', 'judicial'],
    [
      'curtea-de-apel-bucuresti-sectia-a-viii-a-contencios-administrativ-si-fiscal',
      'sentinta',
      'annulment',
    ],
    [
      'inalta-curte-de-casatie-si-justitie-sectia-de-contencios-administrativ-si-fiscal',
      'decizie',
      'annulment',
    ],
  ] as const)('%s %s is %s', (issuer, actType, role) => {
    expect(courtRole(act(issuer, actType))).toBe(role);
  });

  it.each([
    // A court's own plenary or board resolution.
    ['curtea-constitutionala', 'hotarare'],
    ['inalta-curte-de-casatie-si-justitie', 'hotarare'],
    // Not courts; anchored, so a joint order naming the ICCJ is not one.
    ['curtea-de-conturi', 'decizie'],
    ['consiliul-superior-al-magistraturii', 'hotarare'],
    ['ministerul-justitiei-inalta-curte-de-casatie-si-justitie', 'ordin'],
    ['parlamentul-romaniei', 'lege'],
    ['guvernul-romaniei', 'oug'],
    [null, 'decizie'],
  ] as const)('%s %s is not a court decision', (issuer, actType) => {
    expect(courtRole(act(issuer, actType))).toBeNull();
  });

  it('cannot classify a missing act', () => {
    expect(courtRole(null)).toBeNull();
    expect(courtRole(undefined)).toBeNull();
  });
});

describe('isCourtReport', () => {
  const ccr = act('curtea-constitutionala');
  const law = act('parlamentul-romaniei', 'lege');

  it('is a judicial modifica/completeaza/suspenda reference to a non-court act', () => {
    for (const relation of ['modifica', 'completeaza', 'suspenda']) {
      expect(isCourtReport(relation, ccr, law), relation).toBe(true);
    }
  });

  it('is not a repeal, a court target, an annulment, or an unknown act', () => {
    expect(isCourtReport('abroga', ccr, law)).toBe(false);
    expect(isCourtReport('modifica', ccr, act('curtea-de-apel-iasi'))).toBe(false);
    expect(
      isCourtReport('modifica', ccr, act('curtea-europeana-a-drepturilor-omului', 'hotarare'))
    ).toBe(false);
    expect(
      isCourtReport(
        'modifica',
        act('curtea-de-apel-cluj-sectia-a-iii-a-contencios-administrativ-si-fiscal', 'sentinta'),
        law
      )
    ).toBe(false);
    expect(isCourtReport('modifica', null, law)).toBe(false);
    expect(isCourtReport('modifica', ccr, null)).toBe(false);
    expect(isCourtReport('modifica', ccr, undefined)).toBe(false);
  });
});
