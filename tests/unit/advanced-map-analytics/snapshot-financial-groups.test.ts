import { describe, expect, it } from 'vitest';

import { deriveSnapshotFinancialGroups } from '@/modules/advanced-map-analytics/shell/rest/snapshot-financial-groups.js';

const source = {
  id: 'money',
  type: 'line-items-aggregated-yearly',
  enabled: false,
  filter: { normalization: 'per_capita' },
};
const grouped = {
  id: 'grouped',
  type: 'map-grouped-value-series',
  sourceSeriesId: 'money',
  groupWorkspaceId: 'w',
};
const workspace = {
  id: 'w',
  groups: [{ id: 'g', memberSirutaCodes: [' 200 ', '100', '200', ''] }],
};
const expected = {
  groupWorkspaceId: 'w',
  groupId: 'g',
  sourceSeriesId: 'money',
  memberTerritoryCodes: ['100', '200'],
};

describe('snapshot financial groups', () => {
  it('handles incomplete editors and malformed scalar types without coercion', () => {
    expect(deriveSnapshotFinancialGroups({ series: [source, grouped] })._unsafeUnwrap()).toEqual(
      []
    );
    expect(
      deriveSnapshotFinancialGroups({
        series: [{ ...source, type: { toString: null } }, grouped],
      })._unsafeUnwrap()
    ).toEqual([]);
    expect(
      deriveSnapshotFinancialGroups({ series: [source, grouped], groupWorkspaces: {} }).isErr()
    ).toBe(true);
  });
  it('derives one request from many repeated references', () => {
    const result = deriveSnapshotFinancialGroups({
      series: [
        source,
        ...Array.from({ length: 5000 }, (_, index) => ({ ...grouped, id: String(index) })),
      ],
      groupWorkspaces: [workspace],
    });
    expect(result._unsafeUnwrap()).toEqual([expected]);
  });
  it('normalizes exact membership and deduplicates repeated derived series, retaining disabled sources', () => {
    const result = deriveSnapshotFinancialGroups({
      series: [source, grouped, { ...grouped, id: 'another' }],
      groupWorkspaces: [workspace],
    });
    expect(result._unsafeUnwrap()).toEqual([expected]);
  });
  it('keeps different financial sources separate and skips empty groups', () => {
    const result = deriveSnapshotFinancialGroups({
      series: [
        source,
        { ...source, id: 'commit', type: 'commitments-analytics' },
        grouped,
        { ...grouped, id: 'second', sourceSeriesId: 'commit' },
      ],
      groupWorkspaces: [
        { ...workspace, groups: [...workspace.groups, { id: 'empty', memberSirutaCodes: [] }] },
      ],
    });
    expect(result._unsafeUnwrap()).toEqual(
      expect.arrayContaining([expected, { ...expected, sourceSeriesId: 'commit' }])
    );
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });
  it('supports legacy aliases only when modern fields are absent', () => {
    const legacy = {
      id: grouped.id,
      type: grouped.type,
      sourceSeriesId: grouped.sourceSeriesId,
      groupingId: 'w',
    };
    expect(
      deriveSnapshotFinancialGroups({
        series: [source, legacy],
        groupings: [workspace],
      })._unsafeUnwrap()
    ).toEqual([expected]);
    expect(
      deriveSnapshotFinancialGroups({
        series: [source, legacy],
        groupWorkspaces: [],
        groupings: [workspace],
      })._unsafeUnwrap()
    ).toEqual([]);
    expect(
      deriveSnapshotFinancialGroups({
        series: [source, { ...legacy, groupWorkspaceId: '' }],
        groupWorkspaces: [workspace],
      })._unsafeUnwrap()
    ).toEqual([]);
  });
  it.each(['total', 'total_euro', 'percent_gdp'])(
    'does not derive additive %s requests',
    (normalization) => {
      expect(
        deriveSnapshotFinancialGroups({
          series: [{ ...source, filter: { normalization } }, grouped],
        })._unsafeUnwrap()
      ).toEqual([]);
    }
  );
  it.each(['ins-series', 'uploaded-map-dataset', 'aggregated-series-calculation'])(
    'does not derive requests for %s sources',
    (type) => {
      expect(
        deriveSnapshotFinancialGroups({ series: [{ ...source, type }, grouped] })._unsafeUnwrap()
      ).toEqual([]);
    }
  );
  it('does not request annual unions for first aggregation', () => {
    expect(
      deriveSnapshotFinancialGroups({
        series: [source, { ...grouped, aggregation: 'first' }],
      })._unsafeUnwrap()
    ).toEqual([]);
  });
  it.each([
    [workspace, workspace],
    [{ ...workspace, groups: [workspace.groups[0], workspace.groups[0]] }],
    [{ ...workspace, groups: [{ id: 'g', memberSirutaCodes: [100] }] }],
    [{ ...workspace, groups: [workspace.groups[0], { id: 'other', memberSirutaCodes: ['100'] }] }],
  ])('rejects ambiguous membership %j', (...groupWorkspaces) => {
    expect(
      deriveSnapshotFinancialGroups({ series: [source, grouped], groupWorkspaces }).isErr()
    ).toBe(true);
  });
});
