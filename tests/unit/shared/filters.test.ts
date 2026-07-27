/**
 * Kernel filter pipeline: spec → SQL compile, surface derivation, canonical
 * hash stability, array-membership (§15.6), exclusion, op validation.
 */

import { describe, expect, it } from 'vitest';

import { canonicalizeFilters, fhashFor, filterHash } from '@/modules/shared/core/filters/derive.js';
import {
  graphqlFilterTypeName,
  toGraphQLInput,
  toTypeBox,
} from '@/modules/shared/core/filters/surfaces.js';
import { toConditionBuilders } from '@/modules/shared/shell/filters/derive.js';

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
    {
      name: 'value',
      type: 'money',
      ops: ['gte', 'lte', 'between', 'eq', 'in'],
      column: { alias: 'c', column: 'amount_ron' },
    },
  ],
  sort: { default: 'year', allowed: ['year', 'amount'] },
};

describe('toConditionBuilders → SQL', () => {
  it('compiles eq + range to parameterized SQL', () => {
    const res = toConditionBuilders(spec, { year: { between: { from: 2020, to: 2023 } } });
    expect(res.isOk()).toBe(true);
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toMatchInlineSnapshot(
      `"where "c"."flow_year" >= $1 AND "c"."flow_year" <= $2"`
    );
    expect(compiled.parameters).toEqual([2020, 2023]);
  });

  it('applies the declared default when a field is absent', () => {
    const defaultedSpec: CollectionFilterSpec = {
      collection: 'defaulted',
      fields: [
        {
          name: 'year',
          type: 'int',
          ops: ['eq'],
          column: { alias: 'c', column: 'flow_year' },
          default: 2024,
        },
      ],
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
    const f = compileWhere(
      toConditionBuilders(spec, { amount: { isNull: false } })._unsafeUnwrap()
    );
    expect(f.sql).toContain('is not null');
  });

  it('compiles money gte as ::numeric vs ::numeric with the value as a string', () => {
    const res = toConditionBuilders(spec, { value: { gte: '1000000.50' } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('::numeric');
    expect(compiled.sql).toContain('>=');
    // value bound as a STRING, never a JS float.
    expect(compiled.parameters).toEqual(['1000000.50']);
  });

  it('compiles money between as a numeric range', () => {
    const res = toConditionBuilders(spec, { value: { between: { from: '100', to: '200.25' } } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('::numeric >= ');
    expect(compiled.sql).toContain('::numeric <= ');
    expect(compiled.parameters).toEqual(['100', '200.25']);
  });

  it('accepts a JS number money input but binds it as a string', () => {
    const res = toConditionBuilders(spec, { value: { eq: 1500 as unknown as string } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.parameters).toEqual(['1500']);
  });

  it('rejects a non-decimal money value', () => {
    const res = toConditionBuilders(spec, { value: { gte: 'lots' } });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('compiles money IN with numeric casts on both sides', () => {
    const res = toConditionBuilders(spec, { value: { in: ['100', '200.5'] } });
    const compiled = compileWhere(res._unsafeUnwrap());
    // lhs cast + each value cast to numeric (not a raw text in-list).
    expect(compiled.sql).toContain('::numeric in (');
    expect(compiled.sql.match(/::numeric/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(compiled.parameters).toEqual(['100', '200.5']);
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
    expect(fhashFor(spec, { tags: { in: ['b', 'a'] } })).toEqual(
      fhashFor(spec, { tags: { in: ['a', 'b'] } })
    );
  });

  it('treats omitted == explicit default identically', () => {
    const defaultedSpec: CollectionFilterSpec = {
      collection: 'defaulted',
      fields: [
        {
          name: 'year',
          type: 'int',
          ops: ['eq'],
          column: { alias: 'c', column: 'flow_year' },
          default: 2024,
        },
      ],
      sort: { default: 'year', allowed: ['year'] },
    };
    const omitted = canonicalizeFilters(defaultedSpec, {});
    const explicit = canonicalizeFilters(defaultedSpec, { year: { eq: 2024 } });
    expect(omitted).toEqual(explicit);
  });

  it('folds case for an ILIKE operator, whose SQL ignores case too', () => {
    const lo = canonicalizeFilters(spec, { title: { contains: 'ROAD' } });
    const hi = canonicalizeFilters(spec, { title: { contains: 'road' } });
    expect(lo).toEqual(hi);
    expect(canonicalizeFilters(spec, { title: { prefix: 'ROAD' } })).toEqual(
      canonicalizeFilters(spec, { title: { prefix: 'road' } })
    );
  });

  /**
   * REGRESSION (found reviewing the groupVote commit): the fhash must not fold a
   * distinction the QUERY preserves. `=`/`in`/`<`/`>` are case-SENSITIVE in
   * Postgres, so folding them made `cui:{eq:"RO123x"}` and `cui:{eq:"ro123X"}`
   * share a cursor — the cursor decoded happily against a filter that returns a
   * DIFFERENT set of rows, and the client silently paged the wrong (usually empty)
   * result instead of getting an error.
   */
  describe('case is folded ONLY where the query folds it', () => {
    it('keeps case for eq / in — those compile to case-SENSITIVE SQL', () => {
      expect(fhashFor(spec, { cui: { eq: 'PSD' } })).not.toBe(
        fhashFor(spec, { cui: { eq: 'psd' } })
      );
      expect(fhashFor(spec, { cui: { in: ['PSD', 'AUR'] } })).not.toBe(
        fhashFor(spec, { cui: { in: ['psd', 'aur'] } })
      );
    });

    it('keeps case in a between range and in an exclude block', () => {
      expect(fhashFor(spec, { cui: { eq: 'RO1' } })).not.toBe(
        fhashFor(spec, { cui: { eq: 'ro1' } })
      );
      expect(fhashFor(spec, { exclude: { cui: { eq: 'RO1' } } })).not.toBe(
        fhashFor(spec, { exclude: { cui: { eq: 'ro1' } } })
      );
    });

    it('keeps case for `contains` on an ARRAY column — that compiles to @>, not ILIKE', () => {
      expect(fhashFor(spec, { tags: { contains: 'Road' } })).not.toBe(
        fhashFor(spec, { tags: { contains: 'road' } })
      );
      expect(fhashFor(spec, { jtags: { in: ['Road'] } })).not.toBe(
        fhashFor(spec, { jtags: { in: ['road'] } })
      );
    });

    it('leaves the non-string coercions alone (numbers, money, bools still fold)', () => {
      expect(fhashFor(spec, { year: { eq: '2020' as unknown as number } })).toBe(
        fhashFor(spec, { year: { eq: 2020 } })
      );
      expect(fhashFor(spec, { value: { eq: '100.00' } })).toBe(
        fhashFor(spec, { value: { eq: '100' } })
      );
    });
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

  it('normalizes money so "100", "100.00" and 100 hash identically (no float)', () => {
    const a = fhashFor(spec, { value: { gte: '100' } });
    const b = fhashFor(spec, { value: { gte: '100.00' } });
    const c = fhashFor(spec, { value: { gte: 100 as unknown as string } });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
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

  it('renders a money field as the Money scalar (no Float)', () => {
    const sdl = toGraphQLInput(spec);
    // the ContractsValueFilter input uses Money for gte/lte and a Money range.
    expect(sdl).toContain('gte: Money');
    expect(sdl).toContain('between: ContractsValueRange');
    expect(sdl).toMatch(/input ContractsValueRange \{\s*from: Money\s*to: Money\s*\}/u);
  });
});

describe('toTypeBox money', () => {
  it('validates money as a decimal-string pattern (not a number)', () => {
    const schema = toTypeBox(spec);
    const valueProp = schema.properties['value'] as { properties?: Record<string, unknown> };
    expect(valueProp).toBeDefined();
  });
});

// ── #60a: SDL description escaping ────────────────────────────────────────────
describe('toGraphQLInput escapes field descriptions (#60a)', () => {
  const dangerousSpec: CollectionFilterSpec = {
    collection: 'docs',
    fields: [
      {
        name: 'q',
        type: 'string',
        ops: ['contains'],
        column: { alias: 'd', column: 'title' },
        description: 'Search "title" text\nwith a newline and a \\ backslash',
      },
    ],
    sort: { default: 'q', allowed: ['q'] },
  };

  it('escapes quotes/newlines/backslashes so the SDL is one valid line', () => {
    const sdl = toGraphQLInput(dangerousSpec);
    // No raw newline or bare quote inside the description line.
    expect(sdl).toContain('\\"title\\"');
    expect(sdl).toContain('\\n');
    expect(sdl).toContain('\\\\ backslash');
  });

  it('the escaped SDL parses as valid GraphQL (would throw if unescaped)', async () => {
    const { parse } = await import('graphql');
    const sdl = `${toGraphQLInput(dangerousSpec)}\ntype Query { _x: String }`;
    expect(() => parse(sdl)).not.toThrow();
  });
});

// ── #60h: empty in:[] → FALSE, not match-all ──────────────────────────────────
describe('empty in:[] compiles to FALSE (#60h)', () => {
  it('compiles an explicit empty array to a false predicate (match nothing)', () => {
    const res = toConditionBuilders(spec, { status: { in: [] } });
    expect(res.isOk()).toBe(true);
    const compiled = compileWhere(res._unsafeUnwrap());
    // A predicate is emitted (not a dropped/no-op clause that matches ALL).
    expect(compiled.sql.toLowerCase()).toContain('false');
  });

  it('negated empty in:[] under exclude compiles to NOT false (match all of that field)', () => {
    const res = toConditionBuilders(spec, { exclude: { cui: { in: [] } } });
    expect(res.isOk()).toBe(true);
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql.toLowerCase()).toContain('false');
  });
});

// ── #60b: virtual fields are not compiled to SQL ──────────────────────────────
describe('virtual fields are skipped by toConditionBuilders (#60b)', () => {
  const virtualSpec: CollectionFilterSpec = {
    collection: 'budget',
    fields: [
      {
        name: 'reportType',
        type: 'enum',
        ops: ['eq'],
        enumValues: ['ch', 'vn'],
        // repo-intercepted: chooses the partition; no real column to compile.
        column: { alias: 'b', column: 'report_type' },
        virtual: true,
        default: 'ch',
      },
      { name: 'year', type: 'int', ops: ['eq'], column: { alias: 'b', column: 'budget_year' } },
    ],
    sort: { default: 'year', allowed: ['year'] },
  };

  it('does not compile a virtual field, even when present in the input', () => {
    const res = toConditionBuilders(virtualSpec, { reportType: { eq: 'vn' }, year: { eq: 2024 } });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.sql).toContain('budget_year');
    expect(compiled.sql).not.toContain('report_type');
    expect(compiled.parameters).toEqual([2024]);
  });

  it('does not apply a virtual field default on compose', () => {
    const res = toConditionBuilders(virtualSpec, {});
    const compiled = compileWhere(res._unsafeUnwrap());
    // No condition at all — the virtual default ('ch') is repo-handled, not SQL.
    expect(compiled.sql).toBe('');
  });
});

describe('composite fields — a predicate that needs more than one value (§14.2)', () => {
  const compositeSpec: CollectionFilterSpec = {
    collection: 'ballots',
    fields: [
      { name: 'chamber', type: 'string', ops: ['eq'], column: { alias: 'v', column: 'chamber' } },
      {
        name: 'groupVote',
        type: 'string',
        ops: [],
        column: { alias: 'v', column: 'vote_key' },
        virtual: true,
        composite: [
          { name: 'group', type: 'string', required: true, description: 'Stored group name.' },
          {
            name: 'choice',
            type: 'enum',
            enumValues: ['pentru', 'impotriva'],
            graphqlType: 'BallotChoice',
            required: true,
          },
        ],
      },
    ],
    sort: { default: 'voteDate', allowed: ['voteDate'] },
  };

  it('renders named members (both required) instead of operator fields', () => {
    const sdl = toGraphQLInput(compositeSpec);
    expect(sdl).toContain('input BallotsGroupVoteFilter {');
    expect(sdl).toContain('group: String!');
    // A declared graphqlType reuses the module enum instead of widening to String.
    expect(sdl).toContain('choice: BallotChoice!');
    expect(sdl).toContain('"Stored group name."');
    expect(sdl).not.toContain('BallotsGroupVoteRange');
    expect(sdl).toContain('groupVote: BallotsGroupVoteFilter');
  });

  it('validates the members (required, enum domain) on the REST surface', () => {
    const schema = toTypeBox(compositeSpec) as unknown as {
      properties: { groupVote: { required: string[]; properties: Record<string, unknown> } };
    };
    expect(schema.properties.groupVote.required).toEqual(['group', 'choice']);
    expect(Object.keys(schema.properties.groupVote.properties)).toEqual(['group', 'choice']);
  });

  it('hashes each member, so a cursor is bound to the WHOLE predicate', () => {
    const base = fhashFor(compositeSpec, { groupVote: { group: 'PSD', choice: 'pentru' } });
    expect(base).not.toBe(
      fhashFor(compositeSpec, { groupVote: { group: 'AUR', choice: 'pentru' } })
    );
    expect(base).not.toBe(
      fhashFor(compositeSpec, { groupVote: { group: 'PSD', choice: 'impotriva' } })
    );
    // An undeclared member cannot smuggle itself into the hash.
    expect(base).toBe(
      fhashFor(compositeSpec, { groupVote: { group: 'PSD', choice: 'pentru', junk: 'x' } })
    );
    // A member's predicate is repo-owned and matches EXACTLY (vote_records.group_name
    // is case-sensitive), so the cursor must distinguish "PSD" from "psd" — sharing
    // an fhash let a cursor minted on PSD page an empty psd result set.
    expect(base).not.toBe(
      fhashFor(compositeSpec, { groupVote: { group: 'psd', choice: 'pentru' } })
    );
  });

  it('is skipped by the SQL composer (the repo owns the predicate)', () => {
    const res = toConditionBuilders(compositeSpec, {
      chamber: { eq: 'senat' },
      groupVote: { group: 'PSD', choice: 'pentru' },
    });
    const compiled = compileWhere(res._unsafeUnwrap());
    expect(compiled.parameters).toEqual(['senat']);
  });

  it('refuses a NON-virtual composite as a spec bug, not a caller mistake', () => {
    const broken: CollectionFilterSpec = {
      ...compositeSpec,
      fields: compositeSpec.fields.map((f) =>
        f.name === 'groupVote' ? { ...f, virtual: false } : f
      ),
    };
    const res = toConditionBuilders(broken, { groupVote: { group: 'PSD', choice: 'pentru' } });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.message).toContain('must be virtual');
  });
});
