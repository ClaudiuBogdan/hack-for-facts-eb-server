import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { listDatasets } from '@/modules/datasets/core/usecases/list-datasets.js';

import type { DatasetRepo } from '@/modules/datasets/core/ports.js';
import type { Dataset } from '@/modules/datasets/core/types.js';

const createTestDataset = (
  id: string,
  title: string,
  titleEn?: string,
  description?: string
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
      ...(description !== undefined && { description }),
      xAxisLabel: 'An',
      yAxisLabel: 'Valoare',
    },
    ...(titleEn !== undefined && {
      en: {
        title: titleEn,
        ...(description !== undefined && { description: `${description} EN` }),
        xAxisLabel: 'Year',
        yAxisLabel: 'Value',
      },
    }),
  },
  axes: {
    x: { label: 'Year', type: 'date', frequency: 'yearly' },
    y: { label: 'Value', type: 'number', unit: 'unit' },
  },
  points: [
    { x: '2020', y: new Decimal('100') },
    { x: '2021', y: new Decimal('110') },
  ],
});

const testDatasets: Dataset[] = [
  createTestDataset('ro.economics.gdp', 'PIB România', 'Romania GDP', 'Produsul Intern Brut'),
  createTestDataset('ro.economics.cpi', 'Inflație', 'Inflation', 'Indicele prețurilor'),
  createTestDataset('ro.demographics.population', 'Populație', 'Population', 'Populația României'),
  createTestDataset('ro.finance.budget', 'Buget', undefined, 'Bugetul de stat'),
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

describe('listDatasets', () => {
  describe('basic listing', () => {
    it('returns all datasets when no filter is provided', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(4);
      expect(connection.pageInfo.totalCount).toBe(4);
    });

    it('returns empty array when no datasets exist', async () => {
      const repo = makeFakeRepo([]);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(0);
      expect(connection.pageInfo.totalCount).toBe(0);
    });

    it('sorts datasets alphabetically by ID', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const ids = result._unsafeUnwrap().nodes.map((n) => n.id);
      expect(ids).toEqual([...ids].sort());
    });
  });

  describe('pagination', () => {
    it('respects limit parameter', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 2, offset: 0 });

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(2);
      expect(connection.pageInfo.totalCount).toBe(4);
      expect(connection.pageInfo.hasNextPage).toBe(true);
      expect(connection.pageInfo.hasPreviousPage).toBe(false);
    });

    it('respects offset parameter', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 2, offset: 2 });

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(2);
      expect(connection.pageInfo.hasNextPage).toBe(false);
      expect(connection.pageInfo.hasPreviousPage).toBe(true);
    });

    it('handles offset beyond dataset count', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 10, offset: 100 });

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(0);
      expect(connection.pageInfo.totalCount).toBe(4);
    });

    it('treats negative offset as 0', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 10, offset: -5 });

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(4);
      expect(connection.pageInfo.hasPreviousPage).toBe(false);
    });
  });

  describe('ID filtering', () => {
    it('filters by specific IDs', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { ids: ['ro.economics.gdp', 'ro.economics.cpi'] },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(2);
      expect(connection.nodes.map((n) => n.id)).toContain('ro.economics.gdp');
      expect(connection.nodes.map((n) => n.id)).toContain('ro.economics.cpi');
    });

    it('silently omits non-existent IDs', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { ids: ['ro.economics.gdp', 'nonexistent'] },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(1);
    });

    it('returns empty when all IDs are non-existent', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { ids: ['nonexistent1', 'nonexistent2'] },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(0);
    });

    it('treats empty IDs array as no filter', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { ids: [] },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(4);
    });
  });

  describe('search filtering', () => {
    it('searches across title field', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { search: 'PIB' },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes.length).toBeGreaterThan(0);
      expect(connection.nodes[0]?.id).toBe('ro.economics.gdp');
    });

    it('searches across description field', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { search: 'prețurilor' },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes.length).toBeGreaterThan(0);
    });

    it('returns empty when search has no matches', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { search: 'xyznomatch123' },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(0);
    });

    it('treats empty search as no filter', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { search: '' },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(4);
    });

    it('trims whitespace from search term', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: { search: '   PIB   ' },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes.length).toBeGreaterThan(0);
    });
  });

  describe('combined filtering', () => {
    it('applies ID filter before search', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        {
          filter: {
            ids: ['ro.economics.gdp', 'ro.economics.cpi'],
            search: 'PIB',
          },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      // Only GDP matches both filters
      expect(connection.nodes.length).toBe(1);
      expect(connection.nodes[0]?.id).toBe('ro.economics.gdp');
    });
  });

  describe('localization', () => {
    it('returns Romanian content by default', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const gdp = result._unsafeUnwrap().nodes.find((n) => n.id === 'ro.economics.gdp');
      expect(gdp?.name).toBe('PIB România');
      expect(gdp?.title).toBe('PIB România');
    });

    it('returns English content when lang is "en"', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        { limit: 100, offset: 0, lang: 'en' }
      );

      expect(result.isOk()).toBe(true);
      const gdp = result._unsafeUnwrap().nodes.find((n) => n.id === 'ro.economics.gdp');
      expect(gdp?.name).toBe('Romania GDP');
      expect(gdp?.title).toBe('Romania GDP');
    });

    it('falls back to Romanian when English is not available', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        { limit: 100, offset: 0, lang: 'en' }
      );

      expect(result.isOk()).toBe(true);
      // Budget dataset has no English translation
      const budget = result._unsafeUnwrap().nodes.find((n) => n.id === 'ro.finance.budget');
      expect(budget?.name).toBe('Buget');
    });

    it('handles lang variants like "en-US"', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets(
        { datasetRepo: repo },
        { limit: 100, offset: 0, lang: 'en-US' }
      );

      expect(result.isOk()).toBe(true);
      const gdp = result._unsafeUnwrap().nodes.find((n) => n.id === 'ro.economics.gdp');
      expect(gdp?.name).toBe('Romania GDP');
    });
  });

  describe('output mapping', () => {
    it('maps title to both name and title fields', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const nodes = result._unsafeUnwrap().nodes;
      expect(nodes.length).toBeGreaterThan(0);
      const dataset = nodes[0]!;
      expect(dataset.name).toBe(dataset.title);
    });

    it('maps source to sourceName', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const nodes = result._unsafeUnwrap().nodes;
      expect(nodes.length).toBeGreaterThan(0);
      const dataset = nodes[0]!;
      expect(dataset.sourceName).toBe('Test');
    });

    it('maps axis types correctly', async () => {
      const repo = makeFakeRepo(testDatasets);
      const result = await listDatasets({ datasetRepo: repo }, { limit: 100, offset: 0 });

      expect(result.isOk()).toBe(true);
      const nodes = result._unsafeUnwrap().nodes;
      expect(nodes.length).toBeGreaterThan(0);
      const dataset = nodes[0]!;
      expect(dataset.xAxis.type).toBe('DATE');
      expect(dataset.yAxis.type).toBe('FLOAT');
    });
  });

  describe('error propagation', () => {
    it('propagates repository errors', async () => {
      const errorRepo: DatasetRepo = {
        getById: async () => Promise.reject(new Error('Not implemented')),
        listAvailable: async () => Promise.reject(new Error('Not implemented')),
        getByIds: async () => Promise.reject(new Error('Not implemented')),
        getAllWithMetadata: async () =>
          err({ type: 'ReadError' as const, message: 'Failed to read datasets directory' }),
      };

      const result = await listDatasets({ datasetRepo: errorRepo }, { limit: 100, offset: 0 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('ReadError');
    });
  });
});
