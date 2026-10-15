/**
 * Shared Kernel — the spellings a county filter matches (NGO audit F-e).
 *
 * The client's county list, the canonical `core.territories` names and every
 * simple spelling the index actually holds (the 14 October census fixture)
 * must resolve to one set of values per county; a request keeps matching what
 * it matched before (its own literal stays in the set); compound values and
 * NEDETERMINAT are never recast as a county.
 */

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_COUNTY_NAMES,
  buildEntitiesFilter,
  countyFilterValues,
  countyKey,
  requestCountyKey,
} from '@/modules/shared/core/filters/index.js';

import censusFixture from '../../fixtures/global-search/county-facet-census-2026-10-14.json' with { type: 'json' };

/** The website's county list (client `src/lib/territory-counties.ts`, nameRo), in its order. */
const CLIENT_COUNTY_NAMES = [
  'Alba',
  'Arad',
  'Argeș',
  'Bacău',
  'Bihor',
  'Bistrița-Năsăud',
  'Botoșani',
  'Brașov',
  'Brăila',
  'București',
  'Buzău',
  'Caraș-Severin',
  'Călărași',
  'Cluj',
  'Constanța',
  'Covasna',
  'Dâmbovița',
  'Dolj',
  'Galați',
  'Giurgiu',
  'Gorj',
  'Harghita',
  'Hunedoara',
  'Ialomița',
  'Iași',
  'Ilfov',
  'Maramureș',
  'Mehedinți',
  'Mureș',
  'Neamț',
  'Olt',
  'Prahova',
  'Satu Mare',
  'Sălaj',
  'Sibiu',
  'Suceava',
  'Teleorman',
  'Timiș',
  'Tulcea',
  'Vaslui',
  'Vâlcea',
  'Vrancea',
] as const;

/** The census of the dev index's county_name values (ngo, organization_unclassified), classified. */
const CENSUS: {
  simple: Record<string, Record<string, number>>;
  compound: Record<string, Record<string, number>>;
  unknown: Record<string, Record<string, number>>;
} = censusFixture;

const upper = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.normalize('NFC').toLocaleUpperCase('ro-RO')))].sort();
const canonicalOf = (value: string): string | undefined =>
  CANONICAL_COUNTY_NAMES.find((name) => countyKey(name) === requestCountyKey(value));

describe('county filter spellings', () => {
  it('lists the 42 counties once each, every one with its own key', () => {
    expect(CANONICAL_COUNTY_NAMES).toHaveLength(42);
    expect(new Set(CANONICAL_COUNTY_NAMES.map(countyKey)).size).toBe(42);
  });

  it('resolves every client county name to the same set as its canonical name', () => {
    expect(CLIENT_COUNTY_NAMES).toHaveLength(42);
    for (const client of CLIENT_COUNTY_NAMES) {
      const canonical = canonicalOf(client);
      expect(canonical, client).toBeDefined();
      expect(upper(countyFilterValues(client)), client).toEqual(
        upper(countyFilterValues(canonical!))
      );
      expect(upper(countyFilterValues(client)), client).toContain(canonical);
    }
  });

  it('covers every simple spelling the index holds, from the canonical request and from the client request', () => {
    const simple = Object.keys(CENSUS.simple);
    expect(simple.length).toBeGreaterThan(100);
    for (const value of simple) {
      const canonical = canonicalOf(value);
      expect(canonical, `census value ${value} names no county`).toBeDefined();
      const client = CLIENT_COUNTY_NAMES.find((name) => canonicalOf(name) === canonical)!;
      for (const request of [canonical!, client])
        expect(upper(countyFilterValues(request)), `${request} misses ${value}`).toContain(
          upper([value])[0]
        );
    }
  });

  it('keeps a request matching what it matched before: its own literal stays in the set', () => {
    for (const value of [
      ...Object.keys(CENSUS.simple),
      'Satu - Mare',
      'Caraș- Severin',
      'caras  severin',
    ]) {
      expect(upper(countyFilterValues(value)), value).toContain(upper([value])[0]);
    }
    // The two live regressions of the first batch: these exact cohorts were lost by alias-only widening.
    expect(countyFilterValues('Satu - Mare')).toContain('Satu - Mare');
    expect(countyFilterValues('Caraș- Severin')).toContain('Caraș- Severin');
  });

  it('never recasts a compound value or NEDETERMINAT as a county: each matches exactly itself', () => {
    const compound = Object.keys(CENSUS.compound);
    expect(compound).toHaveLength(8);
    for (const value of [...compound, ...Object.keys(CENSUS.unknown)]) {
      expect(countyFilterValues(value), value).toEqual([value]);
    }
  });

  it('matches Bucharest by its canonical, short, ASCII, cedilla and prefixed spellings alike', () => {
    const forms = [
      'București',
      'Bucuresti',
      'BUCURESTI',
      'Bucureşti',
      'MUNICIPIUL BUCUREȘTI',
      'Municipiul Bucureşti',
    ];
    const full = upper(countyFilterValues('MUNICIPIUL BUCUREȘTI'));
    for (const form of forms) expect(upper(countyFilterValues(form)), form).toEqual(full);
    expect(full).toEqual(
      expect.arrayContaining(['MUNICIPIUL BUCUREȘTI', 'BUCUREȘTI', 'BUCURESTI', 'BUCUREŞTI'])
    );
  });

  it('crosses dash and space, comma-below, cedilla and plain letters, and the whole-county prefixes', () => {
    const set = upper(countyFilterValues('Caraș-Severin'));
    for (const form of [
      'Caraș Severin',
      'CARAS-SEVERIN',
      'CARAS SEVERIN',
      'Caraş-Severin',
      'Caraș- Severin',
      'JUD. CARAŞ-SEVERIN',
      'JUDEȚ CARAȘ-SEVERIN',
    ])
      expect(set, form).toContain(upper([form])[0]);
    expect(upper(countyFilterValues('Dâmbovița'))).toEqual(
      expect.arrayContaining(['DÂMBOVIȚA', 'DÂMBOVITA', 'JUD. DÂMBOVIŢA'])
    );
    expect(upper(countyFilterValues('Satu Mare'))).toEqual(
      expect.arrayContaining(['SATU MARE', 'SATU - MARE', 'JUD. SATU-MARE'])
    );
    // A request written with a whole-county prefix names that county.
    expect(upper(countyFilterValues('JUD. CLUJ'))).toEqual(upper(countyFilterValues('Cluj')));
  });

  it('keeps an unknown county exactly as written', () => {
    expect(countyFilterValues('Atlantis')).toEqual(['Atlantis']);
  });
});

describe('county filter spellings — invariants', () => {
  it('folds every generated spelling back to its own county, and covers the ASCII form the registry exports', () => {
    for (const canonical of CANONICAL_COUNTY_NAMES) {
      const key = countyKey(canonical);
      const values = countyFilterValues(canonical);
      for (const value of values)
        expect(requestCountyKey(value), `${canonical}: ${value}`).toBe(key);
      // The registry writes the plain-letter, space-separated form without MUNICIPIUL (CONSTANTA, CARAS SEVERIN, BUCURESTI).
      expect(upper(values), canonical).toContain(key);
      expect(
        values.some((value) => value.startsWith('MUNICIPIUL-')),
        canonical
      ).toBe(false);
      expect(values.length, canonical).toBeLessThanOrEqual(96);
    }
  });

  it('folds as the scrapper projection does (foldCountySql), pair by pair; the request-only prefixes are separate', () => {
    // [spelling, the scrapper's folded key] — src/search/palette-contract.ts foldCountySql in the scrapper.
    for (const [spelling, key] of [
      ['MUNICIPIUL BUCUREȘTI', 'BUCURESTI'],
      ['BUCURESTI', 'BUCURESTI'],
      ['CARAȘ-SEVERIN', 'CARAS SEVERIN'],
      ['Caraș- Severin', 'CARAS SEVERIN'],
      ['Satu - Mare', 'SATU MARE'],
      ['DÂMBOVITA', 'DAMBOVITA'],
      ['BISTRIȚA-NĂSĂUD', 'BISTRITA NASAUD'],
      ['CONSTANŢA', 'CONSTANTA'],
      ['Județul Cluj', 'CLUJ'],
      ['  vâlcea ', 'VALCEA'],
    ] as const) {
      expect(countyKey(spelling), spelling).toBe(key);
    }
    // JUD. / JUDEȚ are recognised on the request side only; the projection's key keeps them.
    expect(countyKey('JUD. CLUJ')).toBe('JUD. CLUJ');
    expect(requestCountyKey('JUD. CLUJ')).toBe('CLUJ');
    expect(requestCountyKey('JUDEȚ CARAȘ-SEVERIN')).toBe('CARAS SEVERIN');
  });

  it('reads a decomposed spelling (s + combining comma) as the same county', () => {
    const decomposed = 'București';
    expect(decomposed).not.toBe('București');
    expect(upper(countyFilterValues(decomposed))).toEqual(upper(countyFilterValues('București')));
    const clause = buildEntitiesFilter({ county: decomposed }).find((c) =>
      c.startsWith('county_name')
    );
    expect(clause).toContain(JSON.stringify('MUNICIPIUL BUCUREȘTI'));
  });
});

describe('buildEntitiesFilter — county spellings', () => {
  it('emits one IN clause with every spelling of a known county and the request itself, each quoted', () => {
    const filter = buildEntitiesFilter({ county: 'Satu - Mare' });
    const clause = filter.find((c) => c.startsWith('county_name'));
    expect(clause).toMatch(/^county_name IN \[/u);
    for (const value of ['SATU MARE', 'Satu - Mare', 'JUD. SATU-MARE'])
      expect(clause).toContain(JSON.stringify(value));
    expect(filter[0]).toBe('privacy_class = "public"');
  });

  it('keeps the exact clause for an unknown or compound county, and still drops an injection', () => {
    expect(buildEntitiesFilter({ county: 'Atlantis' })).toContain('county_name = "Atlantis"');
    expect(buildEntitiesFilter({ county: 'NEDETERMINAT' })).toContain(
      'county_name = "NEDETERMINAT"'
    );
    expect(buildEntitiesFilter({ county: 'Cluj" OR privacy_class = "restricted' })).toEqual([
      'privacy_class = "public"',
    ]);
    expect(buildEntitiesFilter({ county: '' })).toEqual(['privacy_class = "public"']);
  });
});
