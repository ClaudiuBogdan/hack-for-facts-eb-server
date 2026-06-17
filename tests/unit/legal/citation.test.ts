/**
 * Legal — citation parser (the identifier router). Pure unit test. Confirms the
 * conservative `<type> <number>/<year>` shape fires on real citations and falls
 * through (null) on topical/fuzzy queries so the hybrid path runs.
 */

import { describe, expect, it } from 'vitest';

import { parseCitation } from '@/modules/legal/shell/repo/citation.js';

describe('parseCitation — identifier router', () => {
  it('parses "legea 227/2015" → lege 227/2015', () => {
    expect(parseCitation('legea 227/2015')).toEqual({ actType: 'lege', actNumber: '227', actYear: 2015, issuerSlug: '' });
  });

  it('parses the "Legea nr. 227/2015" display form (nr. stripped)', () => {
    expect(parseCitation('Legea nr. 227/2015')).toEqual({ actType: 'lege', actNumber: '227', actYear: 2015, issuerSlug: '' });
  });

  it('maps abbreviations: L / OUG / HG / O', () => {
    expect(parseCitation('L 227/2015')?.actType).toBe('lege');
    expect(parseCitation('oug 57/2019')?.actType).toBe('oug');
    expect(parseCitation('hg 1/2016')?.actType).toBe('hotarare');
    expect(parseCitation('ordinul 1873/2011')?.actType).toBe('ordin');
  });

  it('tolerates spaces around the slash', () => {
    expect(parseCitation('oug 57 / 2019')).toEqual({ actType: 'oug', actNumber: '57', actYear: 2019, issuerSlug: '' });
  });

  it('returns null for a topical query (→ hybrid path)', () => {
    expect(parseCitation('cota de TVA pentru produse alimentare')).toBeNull();
    expect(parseCitation('codul fiscal')).toBeNull(); // alias, not a numbered citation
  });

  it('returns null for an unknown type word or out-of-range year', () => {
    expect(parseCitation('frobnicate 227/2015')).toBeNull();
    expect(parseCitation('legea 227/1700')).toBeNull();
  });
});
