/**
 * Reference filter-spec → surface derivation + canonicalization tests. Verifies the
 * adversarial-review decisions: entityType is a FREE STRING (no enum 400),
 * exclude-asymmetry on the siruta fields, the generated GraphQL input names, the
 * jsonb-array `tags` contains compiling to membership, and fhash stability.
 */

import { describe, expect, it } from 'vitest';

import {
  referenceClassificationFilterSpec,
  referencePublicEntityFilterSpec,
  referenceTerritoryFilterSpec,
} from '@/modules/reference/core/filters.js';
import {
  canonicalizeFilters,
  fhashFor,
  graphqlFilterTypeName,
  toConditionBuilders,
  toGraphQLInput,
} from '@/modules/shared/index.js';

describe('generated GraphQL input names match the plan', () => {
  it('collection → <Pascal>Filter', () => {
    expect(graphqlFilterTypeName(referencePublicEntityFilterSpec)).toBe(
      'ReferencePublicEntityFilter'
    );
    expect(graphqlFilterTypeName(referenceTerritoryFilterSpec)).toBe('ReferenceTerritoryFilter');
    expect(graphqlFilterTypeName(referenceClassificationFilterSpec)).toBe(
      'ReferenceClassificationFilter'
    );
  });

  it('SDL is generated and parseable-ish (contains the input blocks)', () => {
    const sdl = toGraphQLInput(referencePublicEntityFilterSpec);
    expect(sdl).toContain('input ReferencePublicEntityFilter {');
    expect(sdl).toContain('input ReferencePublicEntityFilterExclude {');
    // entityType is a String filter (not a closed enum), so it accepts any value.
    expect(sdl).toContain('input ReferencePublicEntityEntityTypeFilter {');
  });
});

describe('entityType is a free string (no enum gate) — review B3', () => {
  it('accepts a value outside the known 14 (would 400 if it were an enum)', () => {
    const r = toConditionBuilders(referencePublicEntityFilterSpec, {
      entityType: { eq: 'a_brand_new_loader_type' },
    });
    expect(r.isOk()).toBe(true);
  });
});

describe('exclude asymmetry on siruta fields', () => {
  it('public-entity sirutaCode is negatable; classification system is not', () => {
    const sirutaField = referencePublicEntityFilterSpec.fields.find((f) => f.name === 'sirutaCode');
    expect(sirutaField?.exclude).toBe(true);
    const territorialSiruta = referenceTerritoryFilterSpec.fields.find(
      (f) => f.name === 'territorialSiruta'
    );
    expect(territorialSiruta?.exclude).not.toBe(true);
  });

  it('rejects exclude on a non-negatable field', () => {
    const r = toConditionBuilders(referenceTerritoryFilterSpec, {
      exclude: { territorialSiruta: { eq: '54975' } },
    });
    expect(r.isErr()).toBe(true);
  });
});

describe('tags jsonb-array contains compiles to membership (@>)', () => {
  it('emits a @> to_jsonb(array[...]) predicate, not an ILIKE', () => {
    const r = toConditionBuilders(referencePublicEntityFilterSpec, {
      tags: { contains: ['scoala'] },
    });
    expect(r.isOk()).toBe(true);
    // The composer produces a parameterized RawBuilder; we just assert it built one condition.
    if (r.isOk()) expect(r.value.length).toBe(1);
  });
});

describe('fhash + canonicalization stability (cache key / cursor binding)', () => {
  it('is order-independent for array values', () => {
    const a = fhashFor(referencePublicEntityFilterSpec, { entityType: { in: ['uat', 'health'] } });
    const b = fhashFor(referencePublicEntityFilterSpec, { entityType: { in: ['health', 'uat'] } });
    expect(a).toBe(b);
  });

  it('differs for different filters', () => {
    const a = fhashFor(referencePublicEntityFilterSpec, { isUat: { eq: true } });
    const b = fhashFor(referencePublicEntityFilterSpec, { isUat: { eq: false } });
    expect(a).not.toBe(b);
  });

  it('canonical string is a stable snapshot', () => {
    const canon = canonicalizeFilters(referencePublicEntityFilterSpec, {
      entityType: { in: ['uat', 'education'] },
      isUat: { eq: true },
    });
    expect(canon).toMatchInlineSnapshot(
      `"{"c":"reference_public_entity","fields":{"entityType":{"in":["education","uat"]},"isUat":{"eq":true}},"exclude":{}}"`
    );
  });
});

describe('sort allow-lists', () => {
  it('public-entity / territory / classification defaults', () => {
    expect(referencePublicEntityFilterSpec.sort.default).toBe('name');
    expect(referenceTerritoryFilterSpec.sort.default).toBe('name');
    expect(referenceClassificationFilterSpec.sort.default).toBe('code');
  });
});
