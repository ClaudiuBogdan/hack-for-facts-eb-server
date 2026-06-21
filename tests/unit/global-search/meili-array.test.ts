/**
 * Kernel — `buildEntitiesFilter` (the Meili ARRAY filter for the entities index)
 * plus the `validEntityDocTypes` / `normalizeCounty` helpers.
 *
 * Covers the security/allowlist contract: visibility is always pinned; unknown
 * doc_types are dropped; non-integer years are ignored; only shape-valid counties
 * are kept (no quote/operator injection); and the emitted shape is Meili's
 * documented ARRAY-of-expression-STRINGS form (NOT a `['AND', [field,op,val]]`
 * token form, which Meili rejects).
 */

import { describe, expect, it } from 'vitest';

import {
  buildEntitiesFilter,
  normalizeCounty,
  validEntityDocTypes,
} from '@/modules/shared/core/filters/meili-array.js';
import { SEARCH_ENTITY_DOC_TYPES } from '@/modules/shared/core/types.js';

describe('buildEntitiesFilter — visibility gate', () => {
  it('always pins visibility = "public", even with no inputs', () => {
    expect(buildEntitiesFilter({})).toEqual(['visibility = "public"']);
  });

  it('keeps visibility first when other clauses are present', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company'], county: 'Cluj', year: 2024 });
    expect(filter[0]).toBe('visibility = "public"');
  });
});

describe('buildEntitiesFilter — doc_type allowlist', () => {
  it('emits a doc_type IN clause (quoted values) for valid types', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company', 'organization'] });
    expect(filter).toContain('doc_type IN ["company", "organization"]');
  });

  it('drops unknown doc_types (and omits the clause when none remain valid)', () => {
    const filter = buildEntitiesFilter({ docTypes: ['nope', 'also_bad'] });
    expect(filter).toEqual(['visibility = "public"']);
  });

  it('keeps only the valid subset when mixed with unknowns', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company', 'nope', 'bill'] });
    expect(filter).toContain('doc_type IN ["company", "bill"]');
  });

  it('de-duplicates repeated doc_types', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company', 'company'] });
    expect(filter).toContain('doc_type IN ["company"]');
  });

  it('accepts every declared entity doc type', () => {
    const filter = buildEntitiesFilter({ docTypes: [...SEARCH_ENTITY_DOC_TYPES] });
    const expected = `doc_type IN [${SEARCH_ENTITY_DOC_TYPES.map((t) => `"${t}"`).join(', ')}]`;
    expect(filter).toContain(expected);
  });
});

describe('buildEntitiesFilter — year', () => {
  it('emits year = <int> (unquoted number)', () => {
    expect(buildEntitiesFilter({ year: 2024 })).toContain('year = 2024');
  });

  it('ignores a non-integer (float) year', () => {
    expect(buildEntitiesFilter({ year: 2024.5 })).toEqual(['visibility = "public"']);
  });

  it('ignores a NaN year', () => {
    expect(buildEntitiesFilter({ year: Number.NaN })).toEqual(['visibility = "public"']);
  });
});

describe('buildEntitiesFilter — county', () => {
  it('emits county_name = "<value>" for a shape-valid county', () => {
    expect(buildEntitiesFilter({ county: 'Cluj' })).toContain('county_name = "Cluj"');
  });

  it('accepts hyphenated / diacritic county names', () => {
    expect(buildEntitiesFilter({ county: 'Bistrița-Năsăud' })).toContain(
      'county_name = "Bistrița-Năsăud"'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(buildEntitiesFilter({ county: '  Cluj  ' })).toContain('county_name = "Cluj"');
  });

  it('omits the county clause for an empty / whitespace-only string', () => {
    expect(buildEntitiesFilter({ county: '' })).toEqual(['visibility = "public"']);
    expect(buildEntitiesFilter({ county: '   ' })).toEqual(['visibility = "public"']);
  });

  it('drops a county carrying quotes / operators (injection guard)', () => {
    expect(buildEntitiesFilter({ county: 'Cluj" OR visibility = "restricted' })).toEqual([
      'visibility = "public"',
    ]);
    expect(buildEntitiesFilter({ county: 'a]b' })).toEqual(['visibility = "public"']);
  });
});

describe('buildEntitiesFilter — combined shape', () => {
  it('produces visibility, doc_type, county, year clauses in order', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company'], county: 'Cluj', year: 2024 });
    expect(filter).toEqual([
      'visibility = "public"',
      'doc_type IN ["company"]',
      'county_name = "Cluj"',
      'year = 2024',
    ]);
  });
});

describe('validEntityDocTypes', () => {
  it('returns [] for undefined (no filter requested)', () => {
    expect(validEntityDocTypes(undefined)).toEqual([]);
  });

  it('keeps only allowlisted types, deduped + order-preserved', () => {
    expect(validEntityDocTypes(['bill', 'nope', 'company', 'bill'])).toEqual(['bill', 'company']);
  });

  it('returns [] when every requested type is invalid', () => {
    expect(validEntityDocTypes(['nope', 'bad'])).toEqual([]);
  });
});

describe('normalizeCounty', () => {
  it('returns undefined for absent / empty / whitespace input', () => {
    expect(normalizeCounty(undefined)).toBeUndefined();
    expect(normalizeCounty('')).toBeUndefined();
    expect(normalizeCounty('   ')).toBeUndefined();
  });

  it('trims and returns shape-valid names', () => {
    expect(normalizeCounty('  Cluj  ')).toBe('Cluj');
    expect(normalizeCounty('Caraș-Severin')).toBe('Caraș-Severin');
  });

  it('returns undefined for names with quotes / brackets / operators', () => {
    expect(normalizeCounty('Cluj"')).toBeUndefined();
    expect(normalizeCounty('a]b')).toBeUndefined();
    expect(normalizeCounty('x = y')).toBeUndefined();
  });
});
