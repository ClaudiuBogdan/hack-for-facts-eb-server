import { describe, expect, it } from 'vitest';

import {
  compareEnvelopes,
  countByClass,
  describeRootShape,
  isEmptyRootShape,
  relativeDifference,
  type Difference,
  type GraphQLEnvelope,
} from '../../golden-master/compare.js';
import { LosslessNumber, parseEnvelope } from '../../golden-master/envelope.js';

const ok = (data: unknown): GraphQLEnvelope => ({ status: 200, data });

function kinds(differences: readonly Difference[]): string[] {
  return differences.map((d) => `${d.class}/${d.kind}@${d.path}`);
}

describe('golden-master compare: envelope classifier', () => {
  it('reports no differences for identical envelopes', () => {
    const envelope = ok({
      entities: { nodes: [{ cui: '1', name: 'A' }], pageInfo: { totalCount: 1 } },
    });
    const result = compareEnvelopes(envelope, structuredClone(envelope));
    expect(result.differences).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.stats).toEqual({
      leavesCompared: 3,
      totals: { 'contract-break': 0, 'data-parity': 0, rounding: 0 },
    });
  });

  it('classifies an HTTP status change as contract-break', () => {
    const result = compareEnvelopes(
      { status: 200, data: { a: 1 } },
      { status: 400, data: { a: 1 } }
    );
    expect(kinds(result.differences)).toEqual(['contract-break/http-status@$.status']);
  });

  it('classifies errors introduced on the target as contract-break', () => {
    const result = compareEnvelopes(ok({ a: 1 }), {
      status: 200,
      data: null,
      errors: [{ message: 'Cannot query field "a"' }],
    });
    expect(result.differences.map((d) => d.kind)).toContain('errors-introduced');
    expect(result.differences.every((d) => d.class === 'contract-break')).toBe(true);
  });

  it('classifies errors the target no longer produces as contract-break', () => {
    const result = compareEnvelopes(
      {
        status: 400,
        errors: [
          {
            message: 'Variable "$ids" of type "[String!]" used in position expecting type "[ID!]".',
          },
        ],
      },
      { status: 200, data: { budgetSectors: { nodes: [] } } }
    );
    expect(result.differences.map((d) => d.kind)).toEqual(
      expect.arrayContaining(['http-status', 'errors-missing'])
    );
  });

  it('accepts identical error envelopes and flags a changed message, count or path', () => {
    const message = 'Cannot query field "data" on type "Dataset".';
    const same = compareEnvelopes(
      { status: 400, errors: [{ message, locations: [{ line: 11, column: 11 }] }] },
      { status: 400, errors: [{ message }] }
    );
    expect(same.differences).toEqual([]);

    const changed = compareEnvelopes(
      { status: 400, errors: [{ message }] },
      { status: 400, errors: [{ message: 'Field "data" is not defined by type "Dataset".' }] }
    );
    expect(kinds(changed.differences)).toEqual([
      'contract-break/error-message@$.errors[0].message',
    ]);

    const count = compareEnvelopes(
      { status: 400, errors: [{ message }] },
      { status: 400, errors: [{ message }, { message }] }
    );
    expect(kinds(count.differences)).toEqual(['contract-break/error-count@$.errors']);

    const movedPath = compareEnvelopes(
      { status: 200, data: { a: null }, errors: [{ message: 'boom', path: ['a', 0] }] },
      { status: 200, data: { a: null }, errors: [{ message: 'boom', path: ['b'] }] }
    );
    expect(kinds(movedPath.differences)).toEqual(['contract-break/error-path@$.errors[0].path']);
  });

  it('fails a missing key (alias-sensitive) and only warns on an extra key', () => {
    const expected = ok({
      aggregatedLineItems: { nodes: [{ fn_c: '65.02', fn_n: 'Educ', amount: 1 }] },
    });
    const actual = ok({
      aggregatedLineItems: {
        nodes: [{ functional_code: '65.02', fn_n: 'Educ', amount: 1, count: 3 }],
      },
    });
    const result = compareEnvelopes(expected, actual);
    expect(kinds(result.differences)).toEqual([
      'contract-break/missing-key@$.data.aggregatedLineItems.nodes[0].fn_c',
    ]);
    expect(result.warnings.map((w) => `${w.kind}@${w.path}`)).toEqual([
      'extra-key@$.data.aggregatedLineItems.nodes[0].functional_code',
      'extra-key@$.data.aggregatedLineItems.nodes[0].count',
    ]);
  });

  it('classifies a type change as contract-break', () => {
    const result = compareEnvelopes(ok({ value: '12.5' }), ok({ value: 12.5 }));
    expect(kinds(result.differences)).toEqual(['contract-break/type-change@$.data.value']);

    const arrayToObject = compareEnvelopes(ok({ nodes: [] }), ok({ nodes: {} }));
    expect(arrayToObject.differences[0]?.kind).toBe('type-change');
  });

  it('classifies ANY value present on the baseline and null/absent on the target as contract-break', () => {
    const root = compareEnvelopes(ok({ a: 1 }), { status: 200, data: null });
    expect(kinds(root.differences)).toEqual(['contract-break/type-change@$.data']);

    const container = compareEnvelopes(
      ok({ entity: { uat: { name: 'X' } }, entities: { nodes: [{ a: 1 }] } }),
      ok({ entity: { uat: null }, entities: { nodes: null } })
    );
    expect(kinds(container.differences)).toEqual([
      'contract-break/null-loss@$.data.entity.uat',
      'contract-break/null-loss@$.data.entities.nodes',
    ]);

    const scalar = compareEnvelopes(
      ok({ nodes: [{ a: 1 }, { a: 2 }] }),
      ok({ nodes: [{ a: null }, { a: 2 }] })
    );
    expect(kinds(scalar.differences)).toEqual(['contract-break/null-loss@$.data.nodes[0].a']);

    // The other direction (null on the baseline, value on the target) is data parity.
    const gained = compareEnvelopes(
      ok({ entity: { uat: null } }),
      ok({ entity: { uat: { n: 1 } } })
    );
    expect(kinds(gained.differences)).toEqual(['data-parity/null-change@$.data.entity.uat']);
  });

  it('classifies a __typename change as contract-break', () => {
    const result = compareEnvelopes(
      ok({ nodes: [{ __typename: 'CommitmentsAnnualSummary', year: 2025 }] }),
      ok({ nodes: [{ __typename: 'CommitmentsYearlySummary', year: 2025 }] })
    );
    expect(kinds(result.differences)).toEqual([
      'contract-break/typename-change@$.data.nodes[0].__typename',
    ]);
  });

  it('treats pageInfo exactly: value changes, missing pageInfo AND extra keys are contract-breaks', () => {
    const result = compareEnvelopes(
      ok({
        entities: {
          nodes: [],
          pageInfo: { totalCount: 10, hasNextPage: true, hasPreviousPage: false },
        },
      }),
      ok({
        entities: {
          nodes: [],
          pageInfo: { totalCount: 11, hasNextPage: false, hasPreviousPage: false, endCursor: 'x' },
        },
      })
    );
    expect(kinds(result.differences)).toEqual([
      'contract-break/total-count-change@$.data.entities.pageInfo.totalCount',
      'contract-break/page-info-change@$.data.entities.pageInfo.hasNextPage',
      'contract-break/page-info-change@$.data.entities.pageInfo.endCursor',
    ]);
    expect(result.warnings).toEqual([]);

    const gone = compareEnvelopes(
      ok({ entities: { nodes: [], pageInfo: { totalCount: 1 } } }),
      ok({ entities: { nodes: [], pageInfo: null } })
    );
    expect(kinds(gone.differences)).toEqual(['contract-break/null-loss@$.data.entities.pageInfo']);
  });

  it('separates rounding from data drift on numbers', () => {
    const result = compareEnvelopes(
      ok({ a: 1234.5678, b: 10.11, c: 5 }),
      ok({ a: 1234.5681, b: 10.12, c: 5 })
    );
    expect(kinds(result.differences)).toEqual([
      'rounding/value-change@$.data.a',
      'data-parity/value-change@$.data.b',
    ]);
    expect(countByClass(result.differences)).toEqual({
      'contract-break': 0,
      'data-parity': 1,
      rounding: 1,
    });
  });

  it('compares numbers as exact decimals from their wire tokens (beyond 2^53, trailing zeros)', () => {
    const expected = parseEnvelope('{"data":{"total":9007199254740992,"x":1.10}}', 200, 'b');
    const actual = parseEnvelope('{"data":{"total":9007199254740993,"x":1.1}}', 200, 't');
    const result = compareEnvelopes(expected, actual);
    expect(kinds(result.differences)).toEqual(['data-parity/value-change@$.data.total']);
    expect(String(result.differences[0]?.expected)).toBe('9007199254740992');
    expect(String(result.differences[0]?.actual)).toBe('9007199254740993');

    const money = compareEnvelopes(
      parseEnvelope('{"data":{"amount":123456789012345.67}}', 200, 'b'),
      parseEnvelope('{"data":{"amount":123456789012345.671}}', 200, 't')
    );
    expect(kinds(money.differences)).toEqual(['rounding/value-change@$.data.amount']);
  });

  it('honours a custom decimal-places setting', () => {
    const strict = compareEnvelopes(ok({ a: 1.001 }), ok({ a: 1.002 }), { decimalPlaces: 3 });
    expect(strict.differences[0]?.class).toBe('data-parity');
    const loose = compareEnvelopes(ok({ a: 1.001 }), ok({ a: 1.002 }), { decimalPlaces: 2 });
    expect(loose.differences[0]?.class).toBe('rounding');
  });

  it('compares arrays as sequences: the same elements in a different order are ONE array-order contract-break', () => {
    const result = compareEnvelopes(
      ok({
        nodes: [
          { code: 'A', v: 1 },
          { code: 'B', v: 2 },
          { code: 'C', v: 3 },
        ],
      }),
      ok({
        nodes: [
          { code: 'B', v: 2 },
          { code: 'C', v: 3 },
          { code: 'A', v: 1 },
        ],
      })
    );
    expect(kinds(result.differences)).toEqual(['contract-break/array-order@$.data.nodes']);
    expect(result.differences[0]).toMatchObject({ expected: 0, actual: 2 });

    // Lossless and plain numbers are the same element identity.
    const lossless = compareEnvelopes(
      parseEnvelope('{"data":{"n":[1.10,2]}}', 200, 'b'),
      parseEnvelope('{"data":{"n":[2,1.1]}}', 200, 't')
    );
    expect(kinds(lossless.differences)).toEqual(['contract-break/array-order@$.data.n']);

    // Reordered AND drifted: not the same multiset, so element-wise differences.
    const drifted = compareEnvelopes(
      ok({ nodes: [{ code: 'A' }, { code: 'B' }] }),
      ok({ nodes: [{ code: 'B' }, { code: 'X' }] })
    );
    expect(kinds(drifted.differences)).toEqual([
      'data-parity/value-change@$.data.nodes[0].code',
      'data-parity/value-change@$.data.nodes[1].code',
    ]);

    // Single-element and equal arrays never trigger it.
    expect(compareEnvelopes(ok({ n: [1] }), ok({ n: [1] })).differences).toEqual([]);
  });

  it('reports array length changes as data-parity and still diffs the common prefix', () => {
    const result = compareEnvelopes(
      ok({ nodes: [{ code: 'A' }, { code: 'B' }, { code: 'C' }] }),
      ok({ nodes: [{ code: 'A' }, { code: 'X' }] })
    );
    expect(kinds(result.differences)).toEqual([
      'data-parity/array-length@$.data.nodes',
      'data-parity/value-change@$.data.nodes[1].code',
    ]);
  });

  it('returns EVERY element difference (no classification cap) with exact totals', () => {
    const expected = ok({
      nodes: Array.from({ length: 300 }, (_, i) => ({ v: i, k: 'x', __typename: 'T' })),
    });
    const drifted = Array.from({ length: 300 }, (_, i) => ({ v: i + 1, k: 'x', __typename: 'T' }));
    // Beyond any listing cap: a missing key at 260 and a __typename change at 270.
    const at260 = drifted[260]!;
    const at270 = drifted[270]!;
    drifted[260] = { v: at260.v, __typename: 'T' } as (typeof drifted)[number];
    drifted[270] = { ...at270, __typename: 'U' };
    const result = compareEnvelopes(expected, ok({ nodes: drifted }));
    expect(result.differences).toHaveLength(302);
    expect(result.differences.find((d) => d.kind === 'array-diff-truncated')).toBeUndefined();
    expect(result.stats.totals).toEqual({ 'contract-break': 2, 'data-parity': 300, rounding: 0 });
    expect(kinds(result.differences.filter((d) => d.class === 'contract-break'))).toEqual([
      'contract-break/missing-key@$.data.nodes[260].k',
      'contract-break/typename-change@$.data.nodes[270].__typename',
    ]);
  });

  it('computes the relative difference of numeric pairs', () => {
    expect(relativeDifference(100, 190)).toBeCloseTo(0.4736842, 6);
    expect(relativeDifference(new LosslessNumber('100'), new LosslessNumber('100'))).toBe(0);
    expect(relativeDifference(0, 0)).toBe(0);
    expect(relativeDifference(0, 5)).toBe(1);
    expect(relativeDifference('a', 1)).toBeNull();
    expect(relativeDifference(null, 1)).toBeNull();
  });

  it('treats string scalars (INS observation values) literally', () => {
    const result = compareEnvelopes(ok({ value: '1234.50' }), ok({ value: '1234.5' }));
    expect(kinds(result.differences)).toEqual(['data-parity/value-change@$.data.value']);
  });

  it('describes the root shape of data and detects an all-empty baseline', () => {
    const shape = describeRootShape({
      entities: { nodes: [{ a: 1 }], pageInfo: { totalCount: 42 } },
      counties: [],
      entity: { name: 'x' },
      total: 3,
      missing: null,
    });
    expect(shape).toEqual({
      entities: { kind: 'connection', length: 1, totalCount: '42' },
      counties: { kind: 'array', length: 0 },
      entity: { kind: 'object' },
      total: { kind: 'scalar' },
      missing: { kind: 'null' },
    });
    expect(isEmptyRootShape(shape)).toBe(false);
    expect(isEmptyRootShape(describeRootShape({ entities: { nodes: [] }, uats: [] }))).toBe(true);
    expect(isEmptyRootShape(describeRootShape({ entity: { name: 'x' } }))).toBe(false);
  });
});
