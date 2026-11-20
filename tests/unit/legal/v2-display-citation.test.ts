/**
 * The human citation of a legal_v2 act: the legacy formatter (scrapper
 * portal-legislativ/prod/identity.ts displayCitation) over legal_v2's own
 * identity, since legal_v2 stores the natural key as a placeholder.
 */

import { describe, expect, it } from 'vitest';

import { v2DisplayCitation } from '@/modules/legal/core/v2/display-citation.js';

const cite = (
  key: string,
  actType: string,
  actNumber: string | null,
  actYear: number | null,
  issuerSlug: string | null = null,
  storedCitation = key
): string =>
  v2DisplayCitation({
    actNaturalKey: key,
    actType,
    actNumber,
    actYear,
    issuerSlug,
    storedCitation,
  });

describe('v2 display citation', () => {
  it('formats the stored natural key the way the legacy corpus does', () => {
    expect(cite('lege:363:2018:', 'lege', '363', 2018)).toBe('Legea nr. 363/2018');
    expect(cite('decret:945:2001:', 'decret', '945', 2001)).toBe('Decretul nr. 945/2001');
    expect(cite('oug:17:2019:', 'oug', '17', 2019)).toBe('OUG nr. 17/2019');
    expect(cite('ordin:1:2020:anaf', 'ordin', '1', 2020, 'anaf')).toBe('Ordinul nr. 1/2020');
    expect(cite('decret-lege:3:1990:', 'decret-lege', '3', 1990)).toBe('Decretul-lege nr. 3/1990');
  });

  it('tells a Government decision from a body under the Government (I-25)', () => {
    expect(cite('hotarare:5:2020:guvernul', 'hotarare', '5', 2020, 'guvernul')).toBe(
      'HG nr. 5/2020'
    );
    expect(
      cite(
        'hotarare:6:2020:x',
        'hotarare',
        '6',
        2020,
        'guvernul-romaniei-comitetul-national-pentru-situatii-de-urgenta'
      )
    ).toBe('Hotărârea nr. 6/2020');
    expect(cite('hotarare:7:2020:x', 'hotarare', '7', 2020, 'senatul')).toBe(
      'Hotărârea nr. 7/2020'
    );
  });

  it('falls back sensibly without a number or a year, or for another type', () => {
    expect(cite('decret::2001:', 'decret', null, 2001)).toBe('Decretul din 2001');
    expect(cite('lege:12::', 'lege', '12', null)).toBe('Legea nr. 12');
    expect(cite('anexa:3:2019:', 'anexa', '3', 2019)).toBe('Anexa nr. 3/2019');
    expect(cite('unknown:::', 'unknown', null, null)).toBe('Act');
  });

  it('serves a citation the loader already formatted as stored', () => {
    expect(
      cite('lege:363:2018:', 'lege', '363', 2018, null, 'Legea nr. 363/2018 (republicată)')
    ).toBe('Legea nr. 363/2018 (republicată)');
  });
});
