import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  getGroupedSeriesData,
  type GroupedSeriesDataRequest,
  type GroupedSeriesMatrixData,
  type GroupedSeriesProvider,
  serializeWideMatrixCsv,
} from '@/modules/advanced-map-analytics/index.js';

function makeProvider(output: {
  sirutaUniverse?: string[];
  vectors: {
    seriesId: string;
    unit?: string;
    valuesBySirutaCode: Map<string, string | number | undefined>;
  }[];
}): GroupedSeriesProvider {
  return {
    fetchGroupedSeriesVectors: async () =>
      ok({
        sirutaUniverse: output.sirutaUniverse ?? [],
        vectors: output.vectors,
        warnings: [],
      }),
  };
}

describe('getGroupedSeriesData', () => {
  it('returns rows sorted by siruta_code and preserves request series order', async () => {
    const request: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [
        {
          id: 's2',
          type: 'line-items-aggregated-yearly',
          filter: {
            account_category: 'ch',
            report_type: 'Executie bugetara agregata la nivel de ordonator principal',
            report_period: {
              type: Frequency.YEAR,
              selection: {
                interval: {
                  start: '2025',
                  end: '2025',
                },
              },
            },
          },
        },
        {
          id: 's1',
          type: 'commitments-analytics',
          metric: 'CREDITE_ANGAJAMENT',
          filter: {
            report_period: {
              type: Frequency.YEAR,
              selection: {
                interval: {
                  start: '2025',
                  end: '2025',
                },
              },
            },
          },
        },
      ],
    };

    const result = await getGroupedSeriesData(
      {
        provider: makeProvider({
          vectors: [
            {
              seriesId: 's2',
              unit: 'RON',
              valuesBySirutaCode: new Map([
                ['2002', 20],
                ['1001', 10],
              ]),
            },
            {
              seriesId: 's1',
              unit: 'RON',
              valuesBySirutaCode: new Map([['2002', 30]]),
            },
          ],
          sirutaUniverse: ['2002', '1001'],
        }),
        now: () => new Date('2026-02-28T00:00:00.000Z'),
      },
      { request }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    const value: GroupedSeriesMatrixData = result.value;

    expect(value.seriesOrder).toEqual(['s2', 's1']);
    expect(value.rows.map((row) => row.sirutaCode)).toEqual(['1001', '2002']);
    expect(value.rows[0]?.valuesBySeriesId.get('s2')).toBe('10');
    expect(value.rows[0]?.valuesBySeriesId.get('s1')).toBeUndefined();
    expect(value.manifest.generated_at).toBe('2026-02-28T00:00:00.000Z');
    expect(value.manifest.format).toBe('wide_matrix_v1');
    expect(value.manifest.series).toEqual([
      {
        series_id: 's2',
        unit: 'RON',
        defined_value_count: 2,
      },
      {
        series_id: 's1',
        unit: 'RON',
        defined_value_count: 1,
      },
    ]);
  });

  const singleSeriesRequest: GroupedSeriesDataRequest = {
    granularity: 'UAT',
    series: [{ id: 's1', type: 'ins-series', datasetCode: 'POP107D' }],
  };

  it('preserves exact decimal text through provider, matrix and CSV', async () => {
    const result = await getGroupedSeriesData(
      {
        provider: makeProvider({
          sirutaUniverse: ['1001', '1002', '1003', '1004'],
          vectors: [
            {
              seriesId: 's1',
              valuesBySirutaCode: new Map<string, string | number | undefined>([
                ['1001', '9007199254740993.01'],
                ['1002', '9007199254740993.02'],
                ['1003', 0],
                ['1004', undefined],
                ['outside', '12'],
              ]),
            },
          ],
        }),
      },
      { request: singleSeriesRequest }
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.manifest.series[0]?.defined_value_count).toBe(3);
    expect(serializeWideMatrixCsv(result.value.seriesOrder, result.value.rows)).toBe(
      'siruta_code,s1\n1001,9007199254740993.01\n1002,9007199254740993.02\n1003,0\n1004,null'
    );
  });

  it.each([
    'NaN',
    'Infinity',
    '',
    '1,200',
    '=SUM(1)',
    '0x10',
    '1e99999999999999999',
    NaN,
    Infinity,
  ])('rejects malformed provider value %s instead of returning partial data', async (invalid) => {
    const result = await getGroupedSeriesData(
      {
        provider: makeProvider({
          sirutaUniverse: ['1001', '1002'],
          vectors: [
            {
              seriesId: 's1',
              valuesBySirutaCode: new Map<string, string | number | undefined>([
                ['1001', '10'],
                ['1002', invalid],
              ]),
            },
          ],
        }),
      },
      { request: singleSeriesRequest }
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe('ProviderError');
  });

  it.each([null, false, {}])(
    'returns a sanitized error for unexpected provider type %j',
    async (value) => {
      const result = await getGroupedSeriesData(
        {
          provider: makeProvider({
            sirutaUniverse: ['1001'],
            vectors: [
              {
                seriesId: 's1',
                valuesBySirutaCode: new Map([['1001', value as unknown as string]]),
              },
            ],
          }),
        },
        { request: singleSeriesRequest }
      );
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toEqual({
        type: 'ProviderError',
        message: 'Map series provider returned an invalid decimal value',
      });
    }
  );

  it.each([[], ['s1', 's1'], ['s1', 'other'], ['other']])(
    'rejects missing, duplicate or unexpected provider series: %j',
    async (...ids: string[]) => {
      const result = await getGroupedSeriesData(
        {
          provider: makeProvider({
            sirutaUniverse: ['1001'],
            vectors: ids.map((seriesId) => ({
              seriesId,
              valuesBySirutaCode: new Map([['1001', '1']]),
            })),
          }),
        },
        { request: singleSeriesRequest }
      );
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error.type).toBe('ProviderError');
    }
  );

  it('counts no defined values when no territory rows are emitted', async () => {
    const result = await getGroupedSeriesData(
      {
        provider: makeProvider({
          sirutaUniverse: [],
          vectors: [{ seriesId: 's1', valuesBySirutaCode: new Map([['1001', '10']]) }],
        }),
      },
      { request: singleSeriesRequest }
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.rows).toEqual([]);
    expect(result.value.manifest.series[0]?.defined_value_count).toBe(0);
  });

  it('returns invalid input error when duplicate series ids are provided', async () => {
    const request: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [
        {
          id: 'dup',
          type: 'line-items-aggregated-yearly',
          filter: {
            account_category: 'ch',
            report_type: 'Executie bugetara agregata la nivel de ordonator principal',
            report_period: {
              type: Frequency.YEAR,
              selection: {
                interval: {
                  start: '2025',
                  end: '2025',
                },
              },
            },
          },
        },
        {
          id: 'dup',
          type: 'ins-series',
          hasValue: true,
        },
      ],
    };

    const result = await getGroupedSeriesData(
      {
        provider: makeProvider({
          vectors: [],
        }),
      },
      { request }
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.type).toBe('InvalidInputError');
    expect(result.error.message).toContain('Duplicate series id');
  });

  it('returns invalid input error when a series id uses a reserved system prefix', async () => {
    const request: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [
        {
          id: 'group_total',
          type: 'line-items-aggregated-yearly',
          filter: {
            account_category: 'ch',
            report_type: 'Executie bugetara agregata la nivel de ordonator principal',
            report_period: {
              type: Frequency.YEAR,
              selection: {
                interval: {
                  start: '2025',
                  end: '2025',
                },
              },
            },
          },
        },
      ],
    };

    const result = await getGroupedSeriesData(
      {
        provider: makeProvider({
          vectors: [],
        }),
      },
      { request }
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.type).toBe('InvalidInputError');
    expect(result.error.message).toContain('reserved prefix');
    expect(result.error.message).toContain('group_');
  });

  it('returns invalid input error when a series id uses an unsafe CSV prefix', async () => {
    const request: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [
        {
          id: '=sum',
          type: 'line-items-aggregated-yearly',
          filter: {
            account_category: 'ch',
            report_type: 'Executie bugetara agregata la nivel de ordonator principal',
            report_period: {
              type: Frequency.YEAR,
              selection: {
                interval: {
                  start: '2025',
                  end: '2025',
                },
              },
            },
          },
        },
      ],
    };

    const result = await getGroupedSeriesData(
      {
        provider: makeProvider({
          vectors: [],
        }),
      },
      { request }
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }

    expect(result.error.type).toBe('InvalidInputError');
    expect(result.error.message).toContain('unsafe CSV prefix');
    expect(result.error.message).toContain('=');
  });
});
