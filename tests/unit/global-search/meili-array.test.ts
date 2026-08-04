/**
 * Kernel — `buildEntitiesFilter` (the Meili ARRAY filter for the entities index)
 * plus the `validEntityDocTypes` / `normalizeCounty` helpers.
 *
 * Covers the security/allowlist contract: privacy_class is always pinned;
 * unknown doc_types and roles are dropped; only shape-valid counties are kept
 * (no quote/operator injection); and the emitted shape is Meili's documented
 * ARRAY-of-expression-STRINGS form (NOT a `['AND', [field,op,val]]` token form,
 * which Meili rejects).
 */

import { describe, expect, it } from 'vitest';

import {
  buildEntitiesFilter,
  normalizeCounty,
  validEntityDocTypes,
} from '@/modules/shared/core/filters/meili-array.js';
import { SEARCH_ENTITY_DOC_TYPES } from '@/modules/shared/core/types.js';

describe('buildEntitiesFilter — privacy gate', () => {
  it('always pins privacy_class = "public", even with no inputs', () => {
    expect(buildEntitiesFilter({})).toEqual(['privacy_class = "public"']);
  });

  it('keeps the privacy clause first when other clauses are present', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company'], county: 'Cluj', isActive: true });
    expect(filter[0]).toBe('privacy_class = "public"');
  });
});

describe('buildEntitiesFilter — doc_type allowlist', () => {
  it('emits a doc_type IN clause (quoted values) for valid types', () => {
    const filter = buildEntitiesFilter({ docTypes: ['company', 'organization'] });
    expect(filter).toContain('doc_type IN ["company", "organization"]');
  });

  it('drops unknown doc_types (and omits the clause when none remain valid)', () => {
    const filter = buildEntitiesFilter({ docTypes: ['nope', 'also_bad'] });
    expect(filter).toEqual(['privacy_class = "public"']);
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

describe('buildEntitiesFilter — roles', () => {
  it('emits a roles IN clause for valid roles', () => {
    expect(buildEntitiesFilter({ roles: ['pnrr_entity'] })).toContain('roles IN ["pnrr_entity"]');
  });

  it('drops unknown roles entirely', () => {
    expect(buildEntitiesFilter({ roles: ['nope'] })).toEqual(['privacy_class = "public"']);
  });

  it('separates doc_type (what it IS) from roles (what it PLAYS)', () => {
    const filter = buildEntitiesFilter({ docTypes: ['organization'], roles: ['pnrr_entity'] });
    expect(filter).toContain('doc_type IN ["organization"]');
    expect(filter).toContain('roles IN ["pnrr_entity"]');
  });
});

describe('buildEntitiesFilter — is_active', () => {
  it('emits an unquoted boolean', () => {
    expect(buildEntitiesFilter({ isActive: true })).toContain('is_active = true');
    expect(buildEntitiesFilter({ isActive: false })).toContain('is_active = false');
  });

  it('omits the clause when not requested', () => {
    expect(buildEntitiesFilter({})).toEqual(['privacy_class = "public"']);
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
    expect(buildEntitiesFilter({ county: '' })).toEqual(['privacy_class = "public"']);
    expect(buildEntitiesFilter({ county: '   ' })).toEqual(['privacy_class = "public"']);
  });

  it('drops a county carrying quotes / operators (injection guard)', () => {
    expect(buildEntitiesFilter({ county: 'Cluj" OR privacy_class = "restricted' })).toEqual([
      'privacy_class = "public"',
    ]);
    expect(buildEntitiesFilter({ county: 'a]b' })).toEqual(['privacy_class = "public"']);
  });
});

describe('buildEntitiesFilter — combined shape', () => {
  it('produces privacy_class, doc_type, roles, county, is_active clauses in order', () => {
    const filter = buildEntitiesFilter({
      docTypes: ['company'],
      roles: ['pnrr_entity'],
      county: 'Cluj',
      isActive: true,
    });
    expect(filter).toEqual([
      'privacy_class = "public"',
      'doc_type IN ["company"]',
      'roles IN ["pnrr_entity"]',
      'county_name = "Cluj"',
      'is_active = true',
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
