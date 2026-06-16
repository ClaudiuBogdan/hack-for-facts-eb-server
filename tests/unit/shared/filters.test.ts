/**
 * Kernel filter pipeline: spec → SQL compile, surface derivation, canonical
 * hash stability, array-membership (§15.6), exclusion, op validation.
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalizeFilters,
  fhashFor,
  filterHash,
  toConditionBuilders,
} from '@/modules/shared/core/filters/derive.js';
import { graphqlFilterTypeName, toGraphQLInput, toTypeBox } from '@/modules/shared/core/filters/surfaces.js';

import { compileWhere } from './helpers.js';

import type { CollectionFilterSpec } from '@/modules/shared/core/filters/types.js';

const spec: CollectionFilterSpec = {
  collection: 'contracts',
  fields: [
    {
      name: 'year',
      type: 'int',
      ops: ['eq', 'between', 'gte', 'lte'],
      column: { alias: 'c', column: 'flow_year' },
    },
    {
      name: 'cui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'c', column: 'payer_cui' },
      array: true,
      exclude: true,
    },
    {
      name: 'status',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'c', column: 'status' },
      enumValues: ['open', 'closed'],
    },
    {
      name: 'amount',
      type: 'number',
      ops: ['gte', 'lte', 'between', 'isNull'],
      column: { alias: 'c', column: 'amount_ron' },
    },
    {
      name: 'title',
      type: 'string',
      ops: ['contains', 'prefix'],
      column: { alias: 'c', column: 'title' },
    },
    {
      name: 'tags',
      type: 'string',
      ops: ['in', 'contains'],
      column: { alias: 'c', column: 'tags', arrayColumn: true },
    },
    {
      name: 'jtags',
      type: 'string',
      ops: ['in', 'contains'],
      column: { alias: 'c', column: 'attrs_tags', arrayColumn: true, arrayKind: 'jsonb' },
    },
  ],
  sort: { default: 'year', allowed: ['year', 'amount'] },
};

describe('toConditionBuilders → SQL', () => {
  it('compiles eq + range to parameterized SQL', () => {
    const res = toConditionBuilders(spec, { year: { between: { from: 2020, to: 2023 } } });
    expect(res.isOk()).toBe(true);
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toMatchInlineSnapshot(`"where "c"."flow_year" >= $1 AND "c"."flow_year" <= $2"`);
    expect(compiled.parameters).toEqual([2020, 2023]);
  });

  it('applies the declared default when a field is absent', () => {
    const defaultedSpec: CollectionFilterSpec = {
      collection: 'defaulted',
      fields: [{ name: 'year', type: 'int', ops: ['eq'], column: { alias: 'c', column: 'flow_year' }, default: 2024 }],
      sort: { default: 'year', allowed: ['year'] },
    };
    const res = toConditionBuilders(defaultedSpec, {});
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('"c"."flow_year" = $1');
    expect(compiled.parameters).toEqual([2024]);
  });

  it('compiles scalar IN to an in-list', () => {
    const res = toConditionBuilders(spec, { status: { in: ['open', 'closed'] } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('in ($');
    expect(compiled.parameters).toEqual(['open', 'closed']);
  });

  it('compiles array-column IN to overlap (&&), not ILIKE (§15.6)', () => {
    const res = toConditionBuilders(spec, { tags: { in: ['a', 'b'] } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('&&');
    expect(compiled.sql).not.toContain('ilike');
    expect(compiled.parameters).toEqual(['a', 'b']);
  });

  it('compiles array-column contains to @> (§15.6)', () => {
    const res = toConditionBuilders(spec, { tags: { contains: ['x'] } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('@>');
    expect(compiled.parameters).toEqual(['x']);
  });

  it('compiles jsonb-array IN to ?| overlap (§15.6)', () => {
    const res = toConditionBuilders(spec, { jtags: { in: ['a', 'b'] } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('?|');
    expect(compiled.sql).not.toContain('&&');
    expect(compiled.parameters).toEqual(['a', 'b']);
  });

  it('compiles jsonb-array contains to @> to_jsonb(array[…]) (§15.6)', () => {
    const res = toConditionBuilders(spec, { jtags: { contains: ['x'] } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('to_jsonb');
    expect(compiled.sql).toContain('@>');
    expect(compiled.parameters).toEqual(['x']);
  });

  it('compiles scalar contains to ILIKE with wildcards', () => {
    const res = toConditionBuilders(spec, { title: { contains: 'road' } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('ilike');
    expect(compiled.parameters).toEqual(['%road%']);
  });

  it('compiles isNull true/false', () => {
    const t = compileWhere(toConditionBuilders(spec, { amount: { isNull: true } })._unsafeUnwrap());
    expect(t.sql).toContain('is null');
    const f = compileWhere(toConditionBuilders(spec, { amount: { isNull: false } })._unsafeUnwrap());
    expect(f.sql).toContain('is not null');
  });

  it('negates exclude fields with NOT(...)', () => {
    const res = toConditionBuilders(spec, { exclude: { cui: { in: ['111'] } } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('not');
    expect(compiled.parameters).toEqual(['111']);
  });

  it('rejects a disallowed operator', () => {
    const res = toConditionBuilders(spec, { status: { gte: 'open' } });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('rejects an invalid enum value', () => {
    const res = toConditionBuilders(spec, { status: { eq: 'bogus' } });
    expect(res.isErr()).toBe(true);
  });

  it('rejects a non-integer int', () => {
    const res = toConditionBuilders(spec, { year: { eq: 3.5 } });
    expect(res.isErr()).toBe(true);
  });

  it('rejects negation of a non-excludable field', () => {
    const res = toConditionBuilders(spec, { exclude: { status: { eq: 'open' } } });
    expect(res.isErr()).toBe(true);
  });
});

describe('canonicalizeFilters + filterHash', () => {
  it('is stable across array order and key order', () => {
    const a = canonicalizeFilters(spec, { tags: { in: ['b', 'a'] }, status: { eq: 'open' } });
    const b = canonicalizeFilters(spec, { status: { eq: 'open' }, tags: { in: ['a', 'b'] } });
    expect(a).toEqual(b);
    expect(fhashFor(spec, { tags: { in: ['b', 'a'] } })).toEqual(fhashFor(spec, { tags: { in: ['a', 'b'] } }));
  });

  it('treats omitted == explicit default identically', () => {
    const defaultedSpec: CollectionFilterSpec = {
      collection: 'defaulted',
      fields: [{ name: 'year', type: 'int', ops: ['eq'], column: { alias: 'c', column: 'flow_year' }, default: 2024 }],
      sort: { default: 'year', allowed: ['year'] },
    };
    const omitted = canonicalizeFilters(defaultedSpec, {});
    const explicit = canonicalizeFilters(defaultedSpec, { year: { eq: 2024 } });
    expect(omitted).toEqual(explicit);
  });

  it('folds case in string values', () => {
    const lo = canonicalizeFilters(spec, { title: { contains: 'ROAD' } });
    const hi = canonicalizeFilters(spec, { title: { contains: 'road' } });
    expect(lo).toEqual(hi);
  });

  it('coerces numeric fields so REST "2020" == GraphQL 2020 (tri-surface parity)', () => {
    const restStr = canonicalizeFilters(spec, { year: { eq: '2020' as unknown as number } });
    const gqlNum = canonicalizeFilters(spec, { year: { eq: 2020 } });
    expect(restStr).toEqual(gqlNum);
    expect(fhashFor(spec, { year: { eq: '2020' as unknown as number } })).toEqual(
      fhashFor(spec, { year: { eq: 2020 } })
    );
  });

  it('ignores an empty field filter so it does not clobber a default', () => {
    const empty = canonicalizeFilters(spec, { status: {} });
    const absent = canonicalizeFilters(spec, {});
    expect(empty).toEqual(absent);
  });

  it('produces a longer (64-bit) hash than a single 32-bit lane', () => {
    expect(filterHash('hello world').length).toBeGreaterThan(6);
  });

  it('produces a short base36 hash', () => {
    expect(filterHash('x')).toMatch(/^[0-9a-z]+$/u);
  });

  it('different filters produce different hashes', () => {
    expect(fhashFor(spec, { status: { eq: 'open' } })).not.toEqual(
      fhashFor(spec, { status: { eq: 'closed' } })
    );
  });
});

describe('toTypeBox', () => {
  it('builds an object schema with per-field op props', () => {
    const schema = toTypeBox(spec);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toContain('year');
    expect(schema.properties['year']).toBeDefined();
  });
});

describe('toGraphQLInput', () => {
  it('emits a Filter input + range inputs + exclude input', () => {
    const sdl = toGraphQLInput(spec);
    expect(sdl).toContain('input ContractsFilter');
    expect(sdl).toContain('input ContractsYearRange');
    expect(sdl).toContain('input ContractsFilterExclude');
    expect(graphqlFilterTypeName(spec)).toBe('ContractsFilter');
  });

  it('renders array contains as a list, scalar contains as a string', () => {
    const sdl = toGraphQLInput(spec);
    expect(sdl).toContain('contains: [String!]'); // tags (array col)
    expect(sdl).toContain('contains: String'); // title (scalar)
  });
});
