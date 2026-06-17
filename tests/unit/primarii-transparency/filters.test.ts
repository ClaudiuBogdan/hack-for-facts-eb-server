/**
 * Primarii-transparency filter-spec → surface derivation + canonicalization tests.
 * Verifies the review decisions:
 *  - generated GraphQL input names match the plan SDL (`PrimariiEntityFilter` /
 *    `PrimariiDocumentFilter`);
 *  - the closed enums (dataQualityStatus / resultStatus / entityType / category)
 *    reject values outside the live set;
 *  - `missingCategory` is a REAL text[] column compiling to `&&` overlap (NOT virtual);
 *  - the virtual fields are exactly the declared set and the kernel composer skips them;
 *  - fhash stability across logically-equal filters.
 */

import { describe, expect, it } from 'vitest';

import {
  PRIMARII_ENTITY_VIRTUAL_FIELDS,
  PRIMARII_TERRITORY_VIRTUAL_FIELDS,
  primariiDocumentFilterSpec,
  primariiEntityFilterSpec,
} from '@/modules/primarii-transparency/core/filters.js';
import { fhashFor, graphqlFilterTypeName, toConditionBuilders, toGraphQLInput } from '@/modules/shared/index.js';

describe('generated GraphQL input names match the plan SDL', () => {
  it('collection → <Pascal>Filter', () => {
    expect(graphqlFilterTypeName(primariiEntityFilterSpec)).toBe('PrimariiEntityFilter');
    expect(graphqlFilterTypeName(primariiDocumentFilterSpec)).toBe('PrimariiDocumentFilter');
  });

  it('entity SDL contains the closed-enum filter inputs', () => {
    const sdl = toGraphQLInput(primariiEntityFilterSpec);
    expect(sdl).toContain('input PrimariiEntityFilter {');
    expect(sdl).toContain('input PrimariiEntityFilterExclude {');
    expect(sdl).toContain('input PrimariiEntityDataQualityStatusFilter {');
    expect(sdl).toContain('input PrimariiEntityMissingCategoryFilter {');
  });
});

describe('closed enums reject out-of-set values (curated registry)', () => {
  it('dataQualityStatus rejects an unknown value', () => {
    const r = toConditionBuilders(primariiEntityFilterSpec, { dataQualityStatus: { in: ['superb'] } });
    expect(r.isErr()).toBe(true);
  });
  it('entityType rejects an unknown value', () => {
    const r = toConditionBuilders(primariiEntityFilterSpec, { entityType: { in: ['admin_galaxy_hall'] } });
    expect(r.isErr()).toBe(true);
  });
  it('accepts the live enum values', () => {
    const r = toConditionBuilders(primariiEntityFilterSpec, {
      dataQualityStatus: { in: ['high', 'medium'] },
      resultStatus: { in: ['complete'] },
      entityType: { in: ['admin_municipality'] },
    });
    expect(r.isOk()).toBe(true);
  });
});

describe('missingCategory is a REAL text[] column → && overlap (not virtual)', () => {
  it('compiles via the kernel composer (not skipped) and validates the enum', () => {
    const field = primariiEntityFilterSpec.fields.find((f) => f.name === 'missingCategory');
    expect(field?.virtual).not.toBe(true);
    expect(field?.column.arrayColumn).toBe(true);
    expect(field?.column.arrayKind).toBe('text');
    const r = toConditionBuilders(primariiEntityFilterSpec, { missingCategory: { in: ['salarii'] } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.length).toBe(1); // one && predicate emitted
  });
  it('rejects an unknown category', () => {
    const r = toConditionBuilders(primariiEntityFilterSpec, { missingCategory: { in: ['parcare'] } });
    expect(r.isErr()).toBe(true);
  });
});

describe('virtual fields are exactly the declared set and the composer skips them', () => {
  it('the entity virtual list does NOT contain missingCategory', () => {
    expect([...PRIMARII_ENTITY_VIRTUAL_FIELDS]).toEqual([
      'region',
      'siruta',
      'isUat',
      'population',
      'hasIssues',
      'publishesCategory',
      'categoryState',
    ]);
    expect([...PRIMARII_ENTITY_VIRTUAL_FIELDS]).not.toContain('missingCategory');
  });

  it('territory virtual fields are the gated subset', () => {
    expect([...PRIMARII_TERRITORY_VIRTUAL_FIELDS]).toEqual(['region', 'siruta', 'isUat', 'population']);
  });

  it('the composer emits NO SQL for a purely-virtual filter (repo intercepts it)', () => {
    // region/publishesCategory are virtual → toConditionBuilders skips them, yielding
    // zero conditions (the repo composes them itself).
    const r = toConditionBuilders(primariiEntityFilterSpec, {
      region: { in: ['Nord-Vest'] },
      publishesCategory: { in: ['salarii'] },
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.length).toBe(0);
  });
});

describe('document spec requires-driving-predicate fields exist + cui/category are indexed', () => {
  it('cui and category are present and hasContent is virtual', () => {
    const names = primariiDocumentFilterSpec.fields.map((f) => f.name);
    expect(names).toContain('cui');
    expect(names).toContain('category');
    const hasContent = primariiDocumentFilterSpec.fields.find((f) => f.name === 'hasContent');
    expect(hasContent?.virtual).toBe(true);
  });
});

describe('fhash is stable across logically-equal entity filters', () => {
  it('order-independent for the same predicate set', () => {
    const a = fhashFor(primariiEntityFilterSpec, {
      dataQualityStatus: { in: ['high'] },
      county: { in: ['CLUJ'] },
    });
    const b = fhashFor(primariiEntityFilterSpec, {
      county: { in: ['CLUJ'] },
      dataQualityStatus: { in: ['high'] },
    });
    expect(a).toBe(b);
  });
  it('differs when a predicate changes', () => {
    const a = fhashFor(primariiEntityFilterSpec, { dataQualityStatus: { in: ['high'] } });
    const b = fhashFor(primariiEntityFilterSpec, { dataQualityStatus: { in: ['low'] } });
    expect(a).not.toBe(b);
  });
});
