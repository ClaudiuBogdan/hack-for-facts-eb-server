import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { getGroupedSeriesData } from '@/modules/advanced-map-analytics/grouped-series/core/usecases/get-grouped-series-data.js';
import {
  makeNativeMapSeriesProvider,
  type NativeMapSeriesProviderDeps,
} from '@/modules/advanced-map-analytics/grouped-series/shell/providers/native-map-series-provider.js';

import { makeFakeRepo } from '../../../fixtures/ins-native/fake-repo.js';

import type { GroupedSeriesDataRequest } from '@/modules/advanced-map-analytics/grouped-series/core/types.js';

const deps = (): NativeMapSeriesProviderDeps => ({
  territoryLookup: (granularity) => async () =>
    granularity === 'County' ? ['CJ', 'AB'] : ['54975', '1017'],
  budget: {
    repo: {
      yearlyAmounts: async (_filter, granularity) => {
        expect(granularity).toBe('County');
        return ok([
          {
            territoryCode: 'CJ',
            year: 2025,
            nominalAmount: '9007199254740993.01',
            territoryIds: [1],
            observationCount: '2',
            coverage: 'mapped',
          },
        ]);
      },
    },
    factors: { yearly: async () => ok(null) },
    population: { annualUnions: async () => ok([]) },
  },
  readCommitments: async () => ok({ unit: 'RON', values: [], years: [], populations: [] }),
  createInsReadSession: () => ({
    getRepo: async () => ok(makeFakeRepo()),
    close: async () => ok(undefined),
  }),
  datasetRepo: { getAccessibleDataset: async () => ok(null) },
});
const request: GroupedSeriesDataRequest = {
  granularity: 'County',
  series: [
    {
      id: 'budget',
      type: 'line-items-aggregated-yearly',
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: { type: Frequency.YEAR, selection: { dates: ['2025'] } },
      },
    },
  ],
};

describe('native map provider composition', () => {
  it('uses native county aggregation and preserves exact values through the matrix', async () => {
    const result = (
      await getGroupedSeriesData({ provider: makeNativeMapSeriesProvider(deps()) }, { request })
    )._unsafeUnwrap();
    expect(result.manifest.granularity).toBe('County');
    expect(result.rows.find((row) => row.sirutaCode === 'CJ')?.valuesBySeriesId.get('budget')).toBe(
      '9007199254740993.01'
    );
  });
  it('returns exact fixed-member group cells separately from territory rows', async () => {
    const result = (
      await getGroupedSeriesData(
        { provider: makeNativeMapSeriesProvider(deps()) },
        {
          request: {
            ...request,
            groups: [
              {
                groupWorkspaceId: 'w',
                groupId: 'g',
                sourceSeriesId: 'budget',
                memberTerritoryCodes: ['CJ'],
              },
            ],
          },
        }
      )
    )._unsafeUnwrap();
    expect(result.groupValues).toEqual([
      {
        groupWorkspaceId: 'w',
        groupId: 'g',
        sourceSeriesId: 'budget',
        memberTerritoryCodes: ['CJ'],
        value: '9007199254740993.01',
        unit: 'RON',
        missingYears: [],
      },
    ]);
    expect(result.rows.some((row) => row.sirutaCode === 'g')).toBe(false);
  });
  it('rejects group members from a different geometry', async () => {
    const result = await getGroupedSeriesData(
      { provider: makeNativeMapSeriesProvider(deps()) },
      {
        request: {
          ...request,
          groups: [
            {
              groupWorkspaceId: 'w',
              groupId: 'g',
              sourceSeriesId: 'budget',
              memberTerritoryCodes: ['54975'],
            },
          ],
        },
      }
    );
    expect(result._unsafeUnwrapErr().type).toBe('InvalidInputError');
  });
  it('keeps per-capita unavailable when an exact annual denominator is missing', async () => {
    const first = request.series[0]!;
    if (first.type !== 'line-items-aggregated-yearly') throw new Error('wrong fixture');
    const result = (
      await makeNativeMapSeriesProvider(deps()).fetchGroupedSeriesVectors({
        ...request,
        series: [{ ...first, filter: { ...first.filter, normalization: 'per_capita' } }],
      })
    )._unsafeUnwrap();
    expect(result.vectors[0]?.valuesBySirutaCode.get('CJ')).toBeUndefined();
    expect(result.warnings[0]?.details).toMatchObject({
      unavailableTerritories: [{ code: 'CJ', missingYears: [2025] }],
    });
  });
  it('propagates source failure instead of falling back to legacy data', async () => {
    const d = deps();
    d.budget.repo.yearlyAmounts = async () =>
      err({ type: 'ServiceUnavailable', message: 'failed' });
    expect(
      (await makeNativeMapSeriesProvider(d).fetchGroupedSeriesVectors(request))._unsafeUnwrapErr()
        .type
    ).toBe('ProviderError');
  });
  it('passes uploaded dataset access through the requesting user on every read', async () => {
    const d = deps();
    const callers: (string | undefined)[] = [];
    d.datasetRepo.getAccessibleDataset = async (input) => {
      callers.push(input.requestUserId);
      return ok(null);
    };
    const provider = makeNativeMapSeriesProvider(d);
    const datasetRequest: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [{ id: 'upload', type: 'uploaded-map-dataset', datasetId: 'private-id' }],
    };
    expect(
      (
        await provider.fetchGroupedSeriesVectors({ ...datasetRequest, requestUserId: 'owner' })
      )._unsafeUnwrapErr().type
    ).toBe('NotFoundError');
    expect((await provider.fetchGroupedSeriesVectors(datasetRequest))._unsafeUnwrapErr().type).toBe(
      'NotFoundError'
    );
    expect(callers).toEqual(['owner', undefined]);
  });
});

describe('native map failure and source boundaries', () => {
  it('routes commitments to the required native reader with the selected county view', async () => {
    const d = deps();
    const calls: string[] = [];
    const provider = makeNativeMapSeriesProvider({
      ...d,
      readCommitments: async (series, granularity) => {
        calls.push(`${series.metric}:${granularity}`);
        return ok({
          unit: 'RON',
          years: [],
          populations: [],
          values: [{ territoryCode: 'CJ', value: '0', status: 'available', missingYears: [] }],
        });
      },
    });
    const result = (
      await provider.fetchGroupedSeriesVectors({
        granularity: 'County',
        series: [
          {
            id: 'commitment',
            type: 'commitments-analytics',
            metric: 'CREDITE_ANGAJAMENT',
            filter: { report_period: { type: Frequency.YEAR, selection: { dates: ['2025'] } } },
          },
        ],
      })
    )._unsafeUnwrap();
    expect(calls).toEqual(['CREDITE_ANGAJAMENT:County']);
    expect(result.vectors[0]?.valuesBySirutaCode.get('CJ')).toBe('0');
  });
  it('contains thrown lookup failures without exposing internal messages', async () => {
    const result = await makeNativeMapSeriesProvider({
      ...deps(),
      territoryLookup: () => async () => {
        throw new Error('private database detail');
      },
    }).fetchGroupedSeriesVectors(request);
    expect(result._unsafeUnwrapErr().message).toBe('Native map data is unavailable');
  });
  it('rejects duplicate boundary identities before reading data', async () => {
    let read = false;
    const d = deps();
    d.budget.repo.yearlyAmounts = async () => {
      read = true;
      return ok([]);
    };
    const result = await makeNativeMapSeriesProvider({
      ...d,
      territoryLookup: () => async () => ['CJ', 'CJ'],
    }).fetchGroupedSeriesVectors(request);
    expect(result.isErr()).toBe(true);
    expect(read).toBe(false);
  });
  it('preserves exact uploaded decimals and reports rows outside the selected geometry', async () => {
    const d = deps();
    d.datasetRepo.getAccessibleDataset = async () =>
      ok({
        id: 'dataset',
        publicId: 'public',
        userId: 'owner',
        title: 'Values',
        description: null,
        markdown: null,
        unit: 'persons',
        visibility: 'private',
        rowCount: 2,
        replacedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        rows: [
          { sirutaCode: 'CJ', valueNumber: '9007199254740993.001', valueJson: null },
          { sirutaCode: '54975', valueNumber: '12', valueJson: null },
        ],
      });
    const result = (
      await makeNativeMapSeriesProvider(d).fetchGroupedSeriesVectors({
        granularity: 'County',
        requestUserId: 'owner',
        series: [{ id: 'upload', type: 'uploaded-map-dataset', datasetId: 'dataset' }],
      })
    )._unsafeUnwrap();
    expect(result.vectors[0]?.valuesBySirutaCode.get('CJ')).toBe('9007199254740993.001');
    expect(result.vectors[0]?.valuesBySirutaCode.has('54975')).toBe(false);
    expect(result.warnings[0]?.details).toEqual({ excludedRows: 1, granularity: 'County' });
  });
  it('rejects ambiguous uploaded references before an access lookup', async () => {
    let read = false;
    const d = deps();
    d.datasetRepo.getAccessibleDataset = async () => {
      read = true;
      return ok(null);
    };
    const result = await makeNativeMapSeriesProvider(d).fetchGroupedSeriesVectors({
      granularity: 'UAT',
      series: [
        { id: 'upload', type: 'uploaded-map-dataset', datasetId: 'id', datasetPublicId: 'public' },
      ],
    });
    expect(result._unsafeUnwrapErr().type).toBe('InvalidInputError');
    expect(read).toBe(false);
  });
});

describe('financial map request work limits', () => {
  it.each([
    { dates: ['2025junk'] },
    { dates: ['0000'] },
    { dates: ['2025', '2025'] },
    { interval: { start: '2025', end: '2024' } },
    { interval: { start: '0001', end: '9999' } },
    { dates: ['2025-01'] },
  ])('rejects invalid or excessive periods before source IO: %j', async (selection) => {
    const provider = { fetchGroupedSeriesVectors: vi.fn() };
    const base = request.series[0]!;
    if (base.type !== 'line-items-aggregated-yearly') throw new Error('wrong fixture');
    const result = await getGroupedSeriesData(
      { provider },
      {
        request: {
          ...request,
          series: [
            {
              ...base,
              filter: {
                ...base.filter,
                report_period: {
                  type: Frequency.YEAR,
                  selection: selection as typeof base.filter.report_period.selection,
                },
              },
            },
          ],
        },
      }
    );
    expect(result._unsafeUnwrapErr().type).toBe('InvalidInputError');
    expect(provider.fetchGroupedSeriesVectors).not.toHaveBeenCalled();
  });
  it('allows a valid historical interval without imposing a coverage cutoff', async () => {
    const provider = {
      fetchGroupedSeriesVectors: vi.fn(async () =>
        ok({ sirutaUniverse: [], vectors: [], warnings: [] })
      ),
    };
    const base = request.series[0]!;
    if (base.type !== 'line-items-aggregated-yearly') throw new Error('wrong fixture');
    await getGroupedSeriesData(
      { provider },
      {
        request: {
          ...request,
          series: [
            {
              ...base,
              filter: {
                ...base.filter,
                report_period: {
                  type: Frequency.YEAR,
                  selection: { interval: { start: '1850', end: '1899' } },
                },
              },
            },
          ],
        },
      }
    );
    expect(provider.fetchGroupedSeriesVectors).toHaveBeenCalledOnce();
  });
  it('rejects aggregate member-year amplification before source IO', async () => {
    const provider = { fetchGroupedSeriesVectors: vi.fn() };
    const base = request.series[0]!;
    if (base.type !== 'line-items-aggregated-yearly') throw new Error('wrong fixture');
    const result = await getGroupedSeriesData(
      { provider },
      {
        request: {
          ...request,
          series: [
            {
              ...base,
              filter: {
                ...base.filter,
                report_period: {
                  type: Frequency.YEAR,
                  selection: { interval: { start: '1800', end: '2199' } },
                },
              },
            },
          ],
          groups: [
            {
              groupWorkspaceId: 'w',
              groupId: 'g',
              sourceSeriesId: 'budget',
              memberTerritoryCodes: Array.from({ length: 4096 }, (_, i) => String(i)),
            },
          ],
        },
      }
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInputError',
      message: expect.stringContaining('member-years'),
    });
    expect(provider.fetchGroupedSeriesVectors).not.toHaveBeenCalled();
  });
});
