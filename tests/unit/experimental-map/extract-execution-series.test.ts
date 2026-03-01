import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { extractExecutionSeriesVector } from '@/modules/experimental-map/shell/providers/extract-execution-series.js';

import type { ExecutionMapSeries } from '@/modules/experimental-map/index.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { UATAnalyticsRepository } from '@/modules/uat-analytics/index.js';

const baseSeries: ExecutionMapSeries = {
  id: 's-execution',
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
    normalization: 'per_capita',
    show_period_growth: true,
  },
};

describe('extractExecutionSeriesVector', () => {
  it('ignores show_period_growth and keeps per-capita undefined when population is missing', async () => {
    const repo: UATAnalyticsRepository = {
      getHeatmapData: async () =>
        ok([
          {
            uat_id: 1,
            uat_code: '1001',
            uat_name: 'UAT 1001',
            siruta_code: '1001',
            county_code: 'CJ',
            county_name: 'Cluj',
            region: 'Nord-Vest',
            population: null,
            year: 2025,
            total_amount: new Decimal(100),
          },
          {
            uat_id: 2,
            uat_code: '1002',
            uat_name: 'UAT 1002',
            siruta_code: '1002',
            county_code: 'CJ',
            county_name: 'Cluj',
            region: 'Nord-Vest',
            population: 100,
            year: 2025,
            total_amount: new Decimal(100),
          },
        ]),
    };

    const normalizationService = {
      generateFactors: async () => ({
        cpi: new Map(),
        eur: new Map(),
        usd: new Map(),
        gdp: new Map(),
        population: new Map(),
      }),
    } as unknown as NormalizationService;

    const result = await extractExecutionSeriesVector(
      {
        uatAnalyticsRepo: repo,
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
    expect(result.value.valuesBySirutaCode.has('1001')).toBe(false);
    expect(result.value.valuesBySirutaCode.get('1002')).toBe(1);
    expect(
      result.value.warnings.some((warning) => warning.type === 'show_period_growth_ignored')
    ).toBe(true);
    expect(result.value.warnings.some((warning) => warning.type === 'missing_population')).toBe(
      true
    );
  });
});
