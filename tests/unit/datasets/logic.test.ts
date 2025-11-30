import { describe, expect, it } from 'vitest';

import { parseDataset } from '@/modules/datasets/core/logic.js';

import type { DatasetFileDTO } from '@/modules/datasets/core/types.js';

const baseDto: DatasetFileDTO = {
  metadata: {
    id: 'ro.economics.fdi.annual',
    source: 'BNR',
    sourceUrl: 'https://example.com',
    lastUpdated: '2024-12-31',
    units: 'million_eur',
    granularity: 'annual',
  },
  i18n: {
    ro: {
      title: 'Title',
      description: 'Desc',
      xAxisLabel: 'An',
      yAxisLabel: 'Milioane',
    },
    en: {
      title: 'Title EN',
      description: 'Desc EN',
      xAxisLabel: 'Year',
      yAxisLabel: 'Millions',
    },
  },
  axes: {
    x: { label: 'An', type: 'date', granularity: 'annual', format: 'YYYY' },
    y: { label: 'Milioane', type: 'number', unit: 'million_eur' },
  },
  data: [
    { x: '2020', y: '1.23' },
    { x: '2021', y: '2.34' },
  ],
};

describe('parseDataset', () => {
  it('parses annual date datasets', () => {
    const result = parseDataset(baseDto);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().points).toHaveLength(2);
  });

  it('fails on invalid monthly date format', () => {
    const dto: DatasetFileDTO = {
      ...baseDto,
      axes: {
        ...baseDto.axes,
        x: { label: 'Luna', type: 'date', granularity: 'monthly', format: 'YYYY-MM' },
      },
      data: [{ x: '2024-13', y: '10' }],
    };

    const result = parseDataset(dto);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('InvalidFormat');
  });

  it('fails on invalid quarter format', () => {
    const dto: DatasetFileDTO = {
      ...baseDto,
      axes: {
        ...baseDto.axes,
        x: { label: 'Trimestru', type: 'date', granularity: 'quarterly', format: 'YYYY-[Q]Q' },
      },
      data: [{ x: '2023-Q5', y: '10' }],
    };

    const result = parseDataset(dto);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('InvalidFormat');
  });

  it('parses number-based x-axis values', () => {
    const dto: DatasetFileDTO = {
      ...baseDto,
      axes: {
        ...baseDto.axes,
        x: { label: 'Index', type: 'number', granularity: 'annual' },
      },
      data: [
        { x: '1', y: '10' },
        { x: '2.5', y: '20.1' },
      ],
    };

    const result = parseDataset(dto);
    expect(result.isOk()).toBe(true);
  });

  it('rejects invalid decimal y values', () => {
    const dto: DatasetFileDTO = {
      ...baseDto,
      data: [{ x: '2020', y: 'NaN' }],
    };

    const result = parseDataset(dto);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('InvalidDecimal');
  });

  it('rejects unit mismatches', () => {
    const dto: DatasetFileDTO = {
      ...baseDto,
      metadata: { ...baseDto.metadata, units: 'other', granularity: 'annual' },
    };

    const result = parseDataset(dto);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('UnitsMismatch');
  });
});
