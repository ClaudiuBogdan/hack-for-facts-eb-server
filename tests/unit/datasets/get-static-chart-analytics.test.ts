import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getStaticChartAnalytics } from '@/modules/datasets/core/usecases/get-static-chart-analytics.js';

import type { DatasetRepo } from '@/modules/datasets/core/ports.js';
import type { Dataset } from '@/modules/datasets/core/types.js';

const createTestDataset = (
  id: string,
  title: string,
  titleEn?: string,
  points: { x: string; y: string }[] = [
    { x: '2020', y: '100' },
    { x: '2021', y: '110' },
  ]
): Dataset => ({
  id,
  metadata: {
    id,
    source: 'Test',
    lastUpdated: '2024-01-01',
    units: 'unit',
    frequency: 'yearly',
  },
  i18n: {
    ro: {
      title,
      xAxisLabel: 'An',
      yAxisLabel: 'Valoare',
    },
    ...(titleEn !== undefined && {
      en: {
        title: titleEn,
        xAxisLabel: 'Year',
        yAxisLabel: 'Value',
      },
    }),
  },
  axes: {
    x: { label: 'Year', type: 'date', frequency: 'yearly' },
    y: { label: 'Value', type: 'number', unit: 'unit' },
  },
  points: points.map((p) => ({ x: p.x, y: new Decimal(p.y) })),
});

const testDatasets: Dataset[] = [
  createTestDataset('gdp', 'PIB', 'GDP'),
  createTestDataset('cpi', 'Inflație', 'Inflation', [
    { x: '2020', y: '1.5' },
    { x: '2021', y: '2.3' },
    { x: '2022', y: '5.1' },
  ]),
  createTestDataset('population', 'Populație', 'Population'),
];

const makeFakeRepo = (datasets: Dataset[]): DatasetRepo => ({
  getById: async (id: string) => {
    const dataset = datasets.find((d) => d.id === id);
    if (dataset !== undefined) {
      return ok(dataset);
    }
    return Promise.reject(new Error(`Not found: ${id}`));
  },
  listAvailable: async () =>
    ok(
      datasets.map((d) => ({
        id: d.id,
        absolutePath: `/test/${d.id}.yaml`,
        relativePath: `${d.id}.yaml`,
      }))
    ),
  getByIds: async (ids: string[]) => {
    const uniqueIds = [...new Set(ids)];
    const results = uniqueIds
      .map((id) => datasets.find((d) => d.id === id))
      .filter((d): d is Dataset => d !== undefined);
    return ok(results);
  },
  getAllWithMetadata: async () => ok(datasets),
});

describe('getStaticChartAnalytics', () => {
  describe('basic retrieval', () => {
    it('returns chart data for valid IDs', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics(
        { datasetRepo: repo },
        { seriesIds: ['gdp', 'cpi'] }
      );

      expect(result.isOk()).toBe(true);
      const series = result._unsafeUnwrap();
      expect(series).toHaveLength(2);
    });

    it('returns empty array for empty seriesIds', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: [] });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(0);
    });

    it('silently omits non-existent IDs', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics(
        { datasetRepo: repo },
        { seriesIds: ['gdp', 'nonexistent', 'cpi'] }
      );

      expect(result.isOk()).toBe(true);
      const series = result._unsafeUnwrap();
      expect(series).toHaveLength(2);
      expect(series.map((s) => s.seriesId)).toEqual(['gdp', 'cpi']);
    });

    it('returns empty when all IDs are non-existent', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics(
        { datasetRepo: repo },
        { seriesIds: ['nonexistent1', 'nonexistent2'] }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('ordering', () => {
    it('maintains order of requested seriesIds', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics(
        { datasetRepo: repo },
        { seriesIds: ['cpi', 'population', 'gdp'] }
      );

      expect(result.isOk()).toBe(true);
      const seriesIds = result._unsafeUnwrap().map((s) => s.seriesId);
      expect(seriesIds).toEqual(['cpi', 'population', 'gdp']);
    });

    it('handles duplicate IDs by returning each unique ID once', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics(
        { datasetRepo: repo },
        { seriesIds: ['gdp', 'gdp', 'cpi', 'gdp'] }
      );

      expect(result.isOk()).toBe(true);
      const series = result._unsafeUnwrap();
      expect(series).toHaveLength(2);
      expect(series.map((s) => s.seriesId)).toEqual(['gdp', 'cpi']);
    });
  });

  describe('data transformation', () => {
    it('converts Decimal y values to numbers', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: ['cpi'] });

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(series.data).toHaveLength(3);
      expect(typeof series.data[0]?.y).toBe('number');
      expect(series.data[0]?.y).toBe(1.5);
      expect(series.data[1]?.y).toBe(2.3);
      expect(series.data[2]?.y).toBe(5.1);
    });

    it('converts x values to strings', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: ['gdp'] });

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(typeof series.data[0]?.x).toBe('string');
      expect(series.data[0]?.x).toBe('2020');
    });

    it('includes correct axis metadata', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: ['gdp'] });

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(series.xAxis.type).toBe('DATE');
      expect(series.yAxis.type).toBe('FLOAT');
      expect(series.yAxis.unit).toBe('unit');
    });
  });

  describe('localization', () => {
    it('returns Romanian axis labels by default', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: ['gdp'] });

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(series.xAxis.name).toBe('An');
      expect(series.yAxis.name).toBe('Valoare');
    });

    it('returns English axis labels when lang is "en"', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics(
        { datasetRepo: repo },
        { seriesIds: ['gdp'], lang: 'en' }
      );

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(series.xAxis.name).toBe('Year');
      expect(series.yAxis.name).toBe('Value');
    });

    it('handles lang variants like "en-GB"', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics(
        { datasetRepo: repo },
        { seriesIds: ['gdp'], lang: 'en-GB' }
      );

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(series.xAxis.name).toBe('Year');
    });
  });

  describe('series structure', () => {
    it('returns correct seriesId', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: ['gdp'] });

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(series.seriesId).toBe('gdp');
    });

    it('includes all data points from dataset', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: ['cpi'] });

      expect(result.isOk()).toBe(true);
      const allSeries = result._unsafeUnwrap();
      expect(allSeries.length).toBeGreaterThan(0);
      const series = allSeries[0]!;
      expect(series.data).toHaveLength(3);
      expect(series.data.map((d) => d.x)).toEqual(['2020', '2021', '2022']);
    });
  });
});
