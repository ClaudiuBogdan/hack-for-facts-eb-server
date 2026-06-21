/**
 * Kernel — `buildEntitiesFilter` (the Meili ARRAY filter for the entities index).
 * Covers the security/allowlist contract: visibility is always pinned; unknown
 * doc_types are dropped; non-integer years are ignored; empty/absent county is
 * omitted; and the emitted array shape is `['AND', [field, op, value], …]`.
 */

import { describe, expect, it } from 'vitest';

import { buildEntitiesFilter } from '@/modules/shared/core/filters/meili-array.js';
import { SEARCH_ENTITY_DOC_TYPES } from '@/modules/shared/core/types.js';

describe('buildEntitiesFilter — visibility gate', () => {
  it('always pins visibility = public, even with no inputs', () => {
    expect(buildEntitiesFilter({})).toEqual(['AND', ['visibility', '=', 'public']]);
  });

  it('keeps visibility first when other clauses are present', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company'], county: 'Cluj', year: 2024 });
    expect(filter[0]).toBe('AND');
    expect(filter[1]).toEqual(['visibility', '=', 'public']);
  });
});

describe('buildEntitiesFilter — doc_type allowlist', () => {
  it('emits a doc_type IN clause for valid types', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company', 'organization'] });
    expect(filter).toContainEqual(['doc_type', 'IN', ['company', 'organization']]);
  });

  it('drops unknown doc_types (and omits the clause when none remain valid)', () => {
    const filter = buildEntitiesFilter({ docTypes: ['nope', 'also_bad'] });
    expect(filter).toEqual(['AND', ['visibility', '=', 'public']]);
  });

  it('keeps only the valid subset when mixed with unknowns', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company', 'nope', 'bill'] });
    expect(filter).toContainEqual(['doc_type', 'IN', ['company', 'bill']]);
  });

  it('de-duplicates repeated doc_types', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company', 'company'] });
    expect(filter).toContainEqual(['doc_type', 'IN', ['company']]);
  });

  it('accepts every declared entity doc type', () => {
    const filter = buildEntitiesFilter({ docTypes: [...SEARCH_ENTITY_DOC_TYPES] });
    expect(filter).toContainEqual(['doc_type', 'IN', [...SEARCH_ENTITY_DOC_TYPES]]);
  });
});

describe('buildEntitiesFilter — year', () => {
  it('emits year = <int> as a string token', () => {
    const filter = buildEntitiesFilter({ year: 2024 });
    expect(filter).toContainEqual(['year', '=', '2024']);
  });

  it('ignores a non-integer (float) year', () => {
    const filter = buildEntitiesFilter({ year: 2024.5 });
    expect(filter).toEqual(['AND', ['visibility', '=', 'public']]);
  });

  it('ignores a NaN year', () => {
    const filter = buildEntitiesFilter({ year: Number.NaN });
    expect(filter).toEqual(['AND', ['visibility', '=', 'public']]);
  });
});

describe('buildEntitiesFilter — county', () => {
  it('emits county_name = <value> for a non-empty county', () => {
    const filter = buildEntitiesFilter({ county: 'Cluj' });
    expect(filter).toContainEqual(['county_name', '=', 'Cluj']);
  });

  it('trims surrounding whitespace', () => {
    const filter = buildEntitiesFilter({ county: '  Cluj  ' });
    expect(filter).toContainEqual(['county_name', '=', 'Cluj']);
  });

  it('omits the county clause for an empty / whitespace-only string', () => {
    expect(buildEntitiesFilter({ county: '' })).toEqual(['AND', ['visibility', '=', 'public']]);
    expect(buildEntitiesFilter({ county: '   ' })).toEqual(['AND', ['visibility', '=', 'public']]);
  });
});

describe('buildEntitiesFilter — combined shape', () => {
  it('produces AND + clauses in [visibility, doc_type, county, year] order', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company'], county: 'Cluj', year: 2024 });
    expect(filter).toEqual([
      'AND',
      ['visibility', '=', 'public'],
      ['doc_type', 'IN', ['company']],
      ['county_name', '=', 'Cluj'],
      ['year', '=', '2024'],
    ]);
  });
});
