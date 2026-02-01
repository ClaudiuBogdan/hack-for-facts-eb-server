import { Decimal } from 'decimal.js';
import { describe, expect, it, afterEach } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo, makeFakeInsDb } from '../fixtures/fakes.js';

import type { Dataset } from '@/modules/datasets/core/types.js';
import type { FastifyInstance } from 'fastify';

interface PointInput {
  x: string;
  y: string;
}

const createTestDataset = (
  id: string,
  title: string,
  titleEn?: string,
  points: PointInput[] = [
    { x: '2020', y: '100' },
    { x: '2021', y: '110' },
  ]
): Dataset => ({
  id,
  metadata: {
    id,
    source: 'Test Source',
    sourceUrl: 'https://example.com',
    lastUpdated: '2024-01-01',
    units: 'million_ron',
    frequency: 'yearly',
  },
  i18n: {
    ro: {
      title,
      description: `Description for ${title}`,
      xAxisLabel: 'An',
      yAxisLabel: 'Valoare',
    },
    ...(titleEn !== undefined && {
      en: {
        title: titleEn,
        description: `Description for ${titleEn}`,
        xAxisLabel: 'Year',
        yAxisLabel: 'Value',
      },
    }),
  },
  axes: {
    x: { label: 'Year', type: 'date', frequency: 'yearly' },
    y: { label: 'Value', type: 'number', unit: 'million_ron' },
  },
  points: points.map((p) => ({ x: p.x, y: new Decimal(p.y) })),
});

describe('Datasets GraphQL API', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('datasets query', () => {
    it('returns all datasets with default parameters', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.gdp': createTestDataset('test.gdp', 'PIB', 'GDP'),
        'test.cpi': createTestDataset('test.cpi', 'Inflatie', 'Inflation'),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          datasets {
            nodes {
              id
              name
              title
              description
              sourceName
              sourceUrl
              xAxis { name type unit }
              yAxis { name type unit }
            }
            pageInfo {
              totalCount
              hasNextPage
              hasPreviousPage
            }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();

      // Should include normalization datasets + custom datasets
      expect(body.data.datasets.nodes.length).toBeGreaterThanOrEqual(2);
      expect(body.data.datasets.pageInfo.totalCount).toBeGreaterThanOrEqual(2);
    });

    it('supports pagination with limit and offset', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.a': createTestDataset('test.a', 'Dataset A'),
        'test.b': createTestDataset('test.b', 'Dataset B'),
        'test.c': createTestDataset('test.c', 'Dataset C'),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          datasets(limit: 2, offset: 0) {
            nodes { id }
            pageInfo {
              totalCount
              hasNextPage
              hasPreviousPage
            }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();

      // 5 normalization datasets + 3 custom = 8 total
      expect(body.data.datasets.nodes).toHaveLength(2);
      expect(body.data.datasets.pageInfo.totalCount).toBe(8);
      expect(body.data.datasets.pageInfo.hasNextPage).toBe(true);
      expect(body.data.datasets.pageInfo.hasPreviousPage).toBe(false);
    });

    it('filters datasets by IDs', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.gdp': createTestDataset('test.gdp', 'PIB'),
        'test.cpi': createTestDataset('test.cpi', 'Inflatie'),
        'test.pop': createTestDataset('test.pop', 'Populatie'),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          datasets(filter: { ids: ["test.gdp", "test.cpi"] }) {
            nodes { id }
            pageInfo { totalCount }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();

      expect(body.data.datasets.nodes).toHaveLength(2);
      expect(body.data.datasets.pageInfo.totalCount).toBe(2);
    });

    it('searches datasets by title', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.gdp': createTestDataset('test.gdp', 'Produsul Intern Brut'),
        'test.cpi': createTestDataset('test.cpi', 'Indice Preturi'),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          datasets(filter: { search: "Produs" }) {
            nodes { id title }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();

      expect(body.data.datasets.nodes.length).toBeGreaterThan(0);
      // First result should be the one matching "Produs"
      const nodes = body.data.datasets.nodes as { id: string; title: string }[];
      const matchingNode = nodes.find((n) => n.title.includes('Produs'));
      expect(matchingNode).toBeDefined();
    });

    it('applies localization with lang parameter', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.gdp': createTestDataset('test.gdp', 'PIB Romania', 'Romania GDP'),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      // Query with ID filter to get just the test dataset
      const queryRo = `
        query {
          datasets(filter: { ids: ["test.gdp"] }) { nodes { id title } }
        }
      `;

      const queryEn = `
        query {
          datasets(filter: { ids: ["test.gdp"] }, lang: "en") { nodes { id title } }
        }
      `;

      const responseRo = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: queryRo },
      });

      const responseEn = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: queryEn },
      });

      expect(responseRo.statusCode).toBe(200);
      expect(responseEn.statusCode).toBe(200);

      const bodyRo = responseRo.json();
      const bodyEn = responseEn.json();

      expect(bodyRo.data.datasets.nodes[0].title).toBe('PIB Romania');
      expect(bodyEn.data.datasets.nodes[0].title).toBe('Romania GDP');
    });
  });

  describe('staticChartAnalytics query', () => {
    it('returns chart data for valid series IDs', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.gdp': createTestDataset('test.gdp', 'PIB', 'GDP', [
          { x: '2020', y: '100' },
          { x: '2021', y: '120' },
          { x: '2022', y: '140' },
        ]),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          staticChartAnalytics(seriesIds: ["test.gdp"]) {
            seriesId
            xAxis { name type unit }
            yAxis { name type unit }
            data { x y }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();

      const series = body.data.staticChartAnalytics;
      expect(series).toHaveLength(1);
      expect(series[0].seriesId).toBe('test.gdp');
      expect(series[0].data).toHaveLength(3);
      expect(series[0].data[0]).toEqual({ x: '2020', y: 100 });
      expect(series[0].data[1]).toEqual({ x: '2021', y: 120 });
      expect(series[0].xAxis.type).toBe('DATE');
      expect(series[0].yAxis.type).toBe('FLOAT');
    });

    it('returns empty array for non-existent IDs', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          staticChartAnalytics(seriesIds: ["nonexistent"]) {
            seriesId
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.staticChartAnalytics).toHaveLength(0);
    });

    it('returns empty array for empty seriesIds', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          staticChartAnalytics(seriesIds: []) {
            seriesId
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.staticChartAnalytics).toHaveLength(0);
    });

    it('applies localization to axis labels', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.gdp': createTestDataset('test.gdp', 'PIB', 'GDP'),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      const queryRo = `
        query {
          staticChartAnalytics(seriesIds: ["test.gdp"]) {
            xAxis { name }
            yAxis { name }
          }
        }
      `;

      const queryEn = `
        query {
          staticChartAnalytics(seriesIds: ["test.gdp"], lang: "en") {
            xAxis { name }
            yAxis { name }
          }
        }
      `;

      const responseRo = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: queryRo },
      });

      const responseEn = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: queryEn },
      });

      expect(responseRo.statusCode).toBe(200);
      expect(responseEn.statusCode).toBe(200);

      const bodyRo = responseRo.json();
      const bodyEn = responseEn.json();

      expect(bodyRo.data.staticChartAnalytics[0].xAxis.name).toBe('An');
      expect(bodyEn.data.staticChartAnalytics[0].xAxis.name).toBe('Year');
    });

    it('returns multiple series in requested order', async () => {
      const customDatasets: Record<string, Dataset> = {
        'test.gdp': createTestDataset('test.gdp', 'PIB'),
        'test.cpi': createTestDataset('test.cpi', 'Inflatie'),
        'test.pop': createTestDataset('test.pop', 'Populatie'),
      };

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),

          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo({ datasets: customDatasets }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          staticChartAnalytics(seriesIds: ["test.pop", "test.gdp", "test.cpi"]) {
            seriesId
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();

      const series = body.data.staticChartAnalytics as { seriesId: string }[];
      const seriesIds = series.map((s) => s.seriesId);
      expect(seriesIds).toEqual(['test.pop', 'test.gdp', 'test.cpi']);
    });
  });
});
