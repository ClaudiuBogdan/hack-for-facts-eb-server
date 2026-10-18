/**
 * Legal — citation parser (the identifier router). Pure unit test. Confirms the
 * conservative `<type> <number>/<year>` shape fires on real citations and falls
 * through (null) on topical/fuzzy queries so the hybrid path runs.
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeAlias,
  parseCitation,
  parseExactCitation,
} from '@/modules/legal/core/citation.js';

describe('parseCitation — identifier router', () => {
  it('parses "legea 227/2015" → lege 227/2015', () => {
    expect(parseCitation('legea 227/2015')).toEqual({
      actType: 'lege',
      actNumber: '227',
      actYear: 2015,
      issuerSlug: '',
    });
  });

  it('parses the "Legea nr. 227/2015" display form (nr. stripped)', () => {
    expect(parseCitation('Legea nr. 227/2015')).toEqual({
      actType: 'lege',
      actNumber: '227',
      actYear: 2015,
      issuerSlug: '',
    });
  });

  it('maps abbreviations: L / OUG / HG / O', () => {
    expect(parseCitation('L 227/2015')?.actType).toBe('lege');
    expect(parseCitation('oug 57/2019')?.actType).toBe('oug');
    expect(parseCitation('hg 1/2016')?.actType).toBe('hotarare');
    expect(parseCitation('ordinul 1873/2011')?.actType).toBe('ordin');
  });

  it('joins a dotted abbreviation into its type word, not its first letter', () => {
    expect(parseCitation('O.U.G. nr. 57/2019 privind Codul administrativ')?.actType).toBe('oug');
    expect(parseCitation('O.G. 2/2001')?.actType).toBe('og');
    expect(parseCitation('H.G. nr. 1/2016')?.actType).toBe('hotarare');
  });

  it('leaves an unknown dotted abbreviation as written (Sol r4)', () => {
    // Joined, "hgr" is no type word; the permissive reading keeps its `h`, as before.
    expect(parseCitation('H.G.R. 1/2016')).toEqual({
      actType: 'hotarare',
      actNumber: '1',
      actYear: 2016,
      issuerSlug: '',
    });
    expect(parseExactCitation('H.G.R. 1/2016')).toBeNull();
  });

  it('tolerates spaces around the slash', () => {
    expect(parseCitation('oug 57 / 2019')).toEqual({
      actType: 'oug',
      actNumber: '57',
      actYear: 2019,
      issuerSlug: '',
    });
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

describe('parseExactCitation (I-21)', () => {
  it.each([
    ['legea 227/2015', 'lege', '227', 2015],
    ['Legea nr. 227/2015', 'lege', '227', 2015],
    ['OUG 57 / 2019', 'oug', '57', 2019],
    ['Ordinul nr. 1/2020.', 'ordin', '1', 2020],
    ['Legea nr . 227/2015', 'lege', '227', 2015],
    ['L. 227/2015', 'lege', '227', 2015],
    ['Legea nr. 227/2015?', 'lege', '227', 2015],
    ['O.U.G. nr. 57/2019', 'oug', '57', 2019],
    ['O. G. 2/2001', 'og', '2', 2001],
    ['H.G. 1/2016', 'hotarare', '1', 2016],
  ])('"%s" is one citation', (q, actType, actNumber, actYear) => {
    expect(parseExactCitation(q)).toEqual({ actType, actNumber, actYear, issuerSlug: '' });
  });

  it.each([
    'ordinul ministrului finanțelor nr. 1/2020',
    'legea 227/2015 și legea 95/2006',
    'legea 227/2015 art. 5',
    'cota de tva 19/2020',
  ])('"%s" is not one citation', (q) => {
    expect(parseExactCitation(q)).toBeNull();
  });
});

describe('normalizeAlias (I-21)', () => {
  it('folds an alias as the stored ones are: ASCII lower case, single-spaced', () => {
    expect(normalizeAlias(' Codul  de procedură penală ')).toBe('codul de procedura penala');
    expect(normalizeAlias('Codul Fiscal')).toBe('codul fiscal');
    // Comma-below and cedilla forms of ș/ț fold alike.
    expect(normalizeAlias('Ordonanța ş ţ ș ț')).toBe('ordonanta s t s t');
  });
});
