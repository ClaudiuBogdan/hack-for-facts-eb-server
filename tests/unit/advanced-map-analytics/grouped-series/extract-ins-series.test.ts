import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { extractInsSeriesVector } from '@/modules/advanced-map-analytics/grouped-series/shell/providers/extract-ins-series.js';

import type { InsMapSeries } from '@/modules/advanced-map-analytics/index.js';
import type { InsRepository } from '@/modules/ins/index.js';

function makeObservation(params: {
  id: string;
  sirutaCode: string;
  period: string;
  value: number;
  unitCode: string;
  classificationCode: string;
}): {
  id: string;
  dataset_code: string;
  matrix_id: number;
  territory: {
    id: number;
    code: string;
    siruta_code: string;
    level: 'LAU';
    name_ro: string;
    path: string;
    parent_id: null;
  };
  time_period: {
    id: number;
    year: number;
    quarter: null;
    month: null;
    periodicity: 'ANNUAL';
    period_start: Date;
    period_end: Date;
    label_ro: null;
    label_en: null;
    iso_period: string;
  };
  unit: {
    id: number;
    code: string;
    symbol: null;
    name_ro: null;
    name_en: null;
  };
  value: Decimal;
  value_status: null;
  classifications: {
    id: number;
    type_id: number;
    type_code: string;
    type_name_ro: null;
    type_name_en: null;
    code: string;
    name_ro: null;
    name_en: null;
    level: null;
    parent_id: null;
    sort_order: null;
  }[];
  dimensions: Record<string, unknown>;
} {
  const year = Number.parseInt(params.period, 10);
  return {
    id: params.id,
    dataset_code: 'INS_X',
    matrix_id: 1,
    territory: {
      id: 1,
      code: params.sirutaCode,
      siruta_code: params.sirutaCode,
      level: 'LAU',
      name_ro: `UAT ${params.sirutaCode}`,
      path: params.sirutaCode,
      parent_id: null,
    },
    time_period: {
      id: year,
      year,
      quarter: null,
      month: null,
      periodicity: 'ANNUAL',
      period_start: new Date(`${params.period}-01-01T00:00:00.000Z`),
      period_end: new Date(`${params.period}-12-31T00:00:00.000Z`),
      label_ro: null,
      label_en: null,
      iso_period: params.period,
    },
    unit: {
      id: 1,
      code: params.unitCode,
      symbol: null,
      name_ro: null,
      name_en: null,
    },
    value: new Decimal(params.value),
    value_status: null,
    classifications: [
      {
        id: 1,
        type_id: 1,
        type_code: 'SEX',
        type_name_ro: null,
        type_name_en: null,
        code: params.classificationCode,
        name_ro: null,
        name_en: null,
        level: null,
        parent_id: null,
        sort_order: null,
      },
    ],
    dimensions: {},
  };
}

describe('extractInsSeriesVector', () => {
  it('returns warning when datasetCode is missing', async () => {
    const insRepo = {} as unknown as InsRepository;
    const series: InsMapSeries = {
      id: 's-ins-empty',
      type: 'ins-series',
    };

    const result = await extractInsSeriesVector(insRepo, series, new Set(['1001']));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.valuesBySirutaCode.size).toBe(0);
    expect(result.value.warnings.some((warning) => warning.type === 'missing_dataset_code')).toBe(
      true
    );
  });

  it('aggregates INS observations by period and then by siruta, with strict classification matching', async () => {
    const insRepo = {
      listObservations: async () =>
        ok({
          nodes: [
            makeObservation({
              id: 'b',
              sirutaCode: '1001',
              period: '2025',
              value: 10,
              unitCode: 'RON',
              classificationCode: 'TOTAL',
            }),
            makeObservation({
              id: 'a',
              sirutaCode: '1001',
              period: '2025',
              value: 20,
              unitCode: 'EUR',
              classificationCode: 'TOTAL',
            }),
            makeObservation({
              id: 'c',
              sirutaCode: '1001',
              period: '2024',
              value: 5,
              unitCode: 'RON',
              classificationCode: 'TOTAL',
            }),
            makeObservation({
              id: 'd',
              sirutaCode: '1002',
              period: '2025',
              value: 99,
              unitCode: 'RON',
              classificationCode: 'OTHER',
            }),
          ],
          pageInfo: {
            totalCount: 4,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        }),
    } as unknown as InsRepository;

    const series: InsMapSeries = {
      id: 's-ins',
      type: 'ins-series',
      datasetCode: 'INS_X',
      aggregation: 'average',
      classificationSelections: {
        SEX: ['TOTAL'],
      },
    };

    const result = await extractInsSeriesVector(insRepo, series, new Set(['1001', '1002']));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    // 2025 average = 15, plus 2024 sum contribution = 5 => 20
    expect(result.value.valuesBySirutaCode.get('1001')).toBe(20);
    expect(result.value.valuesBySirutaCode.has('1002')).toBe(false);
    expect(result.value.warnings.some((warning) => warning.type === 'mixed_unit')).toBe(true);
  });

  it('adds warning when pagination reaches the extraction page cap', async () => {
    let callCount = 0;

    const insRepo = {
      listObservations: async () => {
        callCount += 1;
        return ok({
          nodes: [
            makeObservation({
              id: String(callCount),
              sirutaCode: '1001',
              period: '2025',
              value: 1,
              unitCode: 'RON',
              classificationCode: 'TOTAL',
            }),
          ],
          pageInfo: {
            totalCount: 100_001,
            hasNextPage: true,
            hasPreviousPage: callCount > 1,
          },
        });
      },
    } as unknown as InsRepository;

    const series: InsMapSeries = {
      id: 's-ins-paged',
      type: 'ins-series',
      datasetCode: 'INS_X',
    };

    const result = await extractInsSeriesVector(insRepo, series, new Set(['1001']));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(callCount).toBe(100);
    expect(result.value.valuesBySirutaCode.get('1001')).toBe(100);
    expect(result.value.warnings.some((warning) => warning.type === 'page_limit_reached')).toBe(
      true
    );
  });
});
