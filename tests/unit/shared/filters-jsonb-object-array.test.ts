/**
 * jsonb arrays whose elements are OBJECTS.
 *
 * `core.public_entities.tags` stores `{tag, ruleId, confidence}` per entry so the
 * rule provenance travels with the tag. The generic jsonb operators assume SCALAR
 * elements, and against objects they do not error — they are type-correct jsonb
 * that matches nothing:
 *
 *   tags @> to_jsonb(ARRAY['kind::hospital'])   -> 0 rows   (scalar vs object)
 *   tags ?| ARRAY['kind::hospital']             -> 0 rows   (?| tests top-level KEYS)
 *
 * Verified against live `transparenta_prod`: the string form returned 0 for every
 * tag while the object form returned 364 for `kind::hospital`. The entity tags
 * filter had therefore never matched anything, and nothing failed to say so.
 *
 * These tests pin the compiled SQL rather than a row count, because the defect is
 * in the OPERATOR SHAPE — a row-count test against a fixture with no tags would
 * have passed just as happily.
 */
import { describe, expect, it } from 'vitest';

import { toConditionBuilders } from '@/modules/shared/shell/filters/derive.js';

import { compileWhere } from './helpers.js';

import type { CollectionFilterSpec } from '@/modules/shared/core/filters/types.js';

const objectArraySpec: CollectionFilterSpec = {
  collection: 'public_entities',
  fields: [
    {
      name: 'tags',
      type: 'string',
      ops: ['contains', 'in'],
      column: {
        alias: 'pe',
        column: 'tags',
        arrayColumn: true,
        arrayKind: 'jsonb',
        jsonbElementKey: 'tag',
      },
    },
  ],
  sort: { default: 'tags', allowed: ['tags'] },
};

/** Same column WITHOUT the key — the scalar-element case must not regress. */
const scalarArraySpec: CollectionFilterSpec = {
  collection: 'scalar_jsonb',
  fields: [
    {
      name: 'domains',
      type: 'string',
      ops: ['contains', 'in'],
      column: {
        alias: 's',
        column: 'domains',
        arrayColumn: true,
        arrayKind: 'jsonb',
      },
    },
  ],
  sort: { default: 'domains', allowed: ['domains'] },
};

describe('jsonb array of objects — contains (CONTAINS-ALL)', () => {
  it('reads the element key instead of comparing against a bare scalar', () => {
    const res = toConditionBuilders(objectArraySpec, {
      tags: { contains: ['kind::school', 'level::local'] },
    });
    expect(res.isOk()).toBe(true);
    const compiled = compileWhere(res._unsafeUnwrap());

    // Containment is preserved (still `@>`, so a GIN index remains usable) but the
    // right-hand side is built as objects.
    expect(compiled.sql).toContain('@>');
    expect(compiled.sql).toContain('jsonb_build_object');
    // The bug: a bare scalar array on the right of `@>`.
    expect(compiled.sql).not.toContain('to_jsonb');
    // The element key binds as a parameter too — it is never interpolated.
    expect(compiled.parameters).toEqual(['tag', 'kind::school', 'level::local']);
  });

  it('keeps CONTAINS-ALL semantics, not any-overlap', () => {
    const res = toConditionBuilders(objectArraySpec, {
      tags: { contains: ['kind::school', 'level::local'] },
    });
    const compiled = compileWhere(res._unsafeUnwrap());
    // `@>` over an aggregated array is all-of; an exists/any would be any-of.
    expect(compiled.sql).not.toContain('exists');
  });
});

describe('jsonb array of objects — in (overlap)', () => {
  it('unnests and compares the key rather than using ?|', () => {
    const res = toConditionBuilders(objectArraySpec, {
      tags: { in: ['kind::hospital', 'kind::clinic'] },
    });
    expect(res.isOk()).toBe(true);
    const compiled = compileWhere(res._unsafeUnwrap());

    expect(compiled.sql).toContain('jsonb_array_elements');
    expect(compiled.sql).toContain('->>');
    // `?|` tests top-level keys — meaningless for an array of objects.
    expect(compiled.sql).not.toContain('?|');
    expect(compiled.parameters).toEqual(['tag', 'kind::hospital', 'kind::clinic']);
  });
});

describe('scalar jsonb arrays are unaffected', () => {
  it('still compiles contains to @> to_jsonb(...)', () => {
    const res = toConditionBuilders(scalarArraySpec, {
      domains: { contains: ['fiscal'] },
    });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('to_jsonb');
    expect(compiled.sql).not.toContain('jsonb_build_object');
  });

  it('still compiles in to ?|', () => {
    const res = toConditionBuilders(scalarArraySpec, {
      domains: { in: ['fiscal', 'penal'] },
    });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('?|');
    expect(compiled.sql).not.toContain('jsonb_array_elements');
  });
});
