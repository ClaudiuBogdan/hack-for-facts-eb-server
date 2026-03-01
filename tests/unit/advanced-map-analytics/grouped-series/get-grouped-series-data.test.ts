import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  getGroupedSeriesData,
  type GroupedSeriesDataRequest,
  type GroupedSeriesMatrixData,
  type GroupedSeriesProvider,
} from '@/modules/advanced-map-analytics/index.js';

function makeProvider(output: {
  sirutaUniverse?: string[];
  vectors: {
    seriesId: string;
    unit?: string;
    valuesBySirutaCode: Map<string, number | undefined>;
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
    expect(value.rows[0]?.valuesBySeriesId.get('s2')).toBe(10);
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
});
