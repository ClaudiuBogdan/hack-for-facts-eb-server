import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { extractCommitmentsSeriesVector } from '@/modules/experimental-map/shell/providers/extract-commitments-series.js';

import type { CommitmentsRepository } from '@/modules/commitments/index.js';
import type { CommitmentsMapSeries } from '@/modules/experimental-map/index.js';
import type { NormalizationService } from '@/modules/normalization/index.js';

const baseSeries: CommitmentsMapSeries = {
  id: 's-commitments',
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
    normalization: 'per_capita',
    show_period_growth: true,
  },
};

describe('extractCommitmentsSeriesVector', () => {
  it('sums normalized period values by siruta and drops per-capita rows without population', async () => {
    const commitmentsRepo = {
      getUatMetricRows: async () =>
        ok([
          {
            siruta_code: '1001',
            population: 100,
            year: 2025,
            period_value: 1,
            amount: new Decimal(100),
          },
          {
            siruta_code: '1001',
            population: 100,
            year: 2025,
            period_value: 2,
            amount: new Decimal(50),
          },
          {
            siruta_code: '1002',
            population: null,
            year: 2025,
            period_value: 1,
            amount: new Decimal(30),
          },
        ]),
    } as unknown as CommitmentsRepository;

    const normalizationService = {
      generateFactors: async () => ({
        cpi: new Map(),
        eur: new Map(),
        usd: new Map(),
        gdp: new Map(),
        population: new Map(),
      }),
    } as unknown as NormalizationService;

    const result = await extractCommitmentsSeriesVector(
      {
        commitmentsRepo,
        normalizationService,
      },
      baseSeries,
      new Set(['1001', '1002'])
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.unit).toBe('RON/capita');
    expect(result.value.valuesBySirutaCode.get('1001')).toBe(1.5);
    expect(result.value.valuesBySirutaCode.has('1002')).toBe(false);
    expect(
      result.value.warnings.some((warning) => warning.type === 'show_period_growth_ignored')
    ).toBe(true);
    expect(result.value.warnings.some((warning) => warning.type === 'missing_population')).toBe(
      true
    );
  });
});
