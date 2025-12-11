/**
 * Integration tests for Budget Sector GraphQL API.
 */

import { describe, expect, it, afterEach } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import {
  makeFakeBudgetDb,
  makeFakeDatasetRepo,
  makeFakeBudgetSectorRepo,
} from '../fixtures/fakes.js';

import type { BudgetSector } from '@/modules/budget-sector/index.js';
import type { FastifyInstance } from 'fastify';

describe('Budget Sector GraphQL API', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('budgetSector query', () => {
    it('returns sector when found', async () => {
      const sectors: BudgetSector[] = [
        { sector_id: 1, sector_description: 'Buget local' },
        { sector_id: 2, sector_description: 'Buget de stat' },
      ];

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo({ sectors }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSector(id: "1") {
            sector_id
            sector_description
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
      expect(body.data.budgetSector).toEqual({
        sector_id: '1',
        sector_description: 'Buget local',
      });
    });

    it('returns null for non-existent ID', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo({ sectors: [] }),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSector(id: "999") {
            sector_id
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
      expect(body.data.budgetSector).toBeNull();
    });

    it('returns null for invalid ID (non-numeric)', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSector(id: "abc") {
            sector_id
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
      expect(body.data.budgetSector).toBeNull();
    });

    it('returns null for negative ID', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSector(id: "-1") {
            sector_id
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
      expect(body.data.budgetSector).toBeNull();
    });
  });

  describe('budgetSectors query', () => {
    it('returns all sectors with default pagination', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors {
            nodes {
              sector_id
              sector_description
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

      // Default fake has 4 sectors
      expect(body.data.budgetSectors.nodes).toHaveLength(4);
      expect(body.data.budgetSectors.pageInfo.totalCount).toBe(4);
      expect(body.data.budgetSectors.pageInfo.hasNextPage).toBe(false);
      expect(body.data.budgetSectors.pageInfo.hasPreviousPage).toBe(false);
    });

    it('supports pagination with limit and offset', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(limit: 2, offset: 0) {
            nodes { sector_id }
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

      expect(body.data.budgetSectors.nodes).toHaveLength(2);
      expect(body.data.budgetSectors.pageInfo.totalCount).toBe(4);
      expect(body.data.budgetSectors.pageInfo.hasNextPage).toBe(true);
      expect(body.data.budgetSectors.pageInfo.hasPreviousPage).toBe(false);
    });

    it('respects offset in pagination', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(limit: 2, offset: 2) {
            nodes { sector_id }
            pageInfo {
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

      expect(body.data.budgetSectors.nodes).toHaveLength(2);
      expect(body.data.budgetSectors.pageInfo.hasNextPage).toBe(false);
      expect(body.data.budgetSectors.pageInfo.hasPreviousPage).toBe(true);
    });

    it('filters by search term', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(filter: { search: "local" }) {
            nodes {
              sector_id
              sector_description
            }
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

      expect(body.data.budgetSectors.nodes).toHaveLength(1);
      expect(body.data.budgetSectors.nodes[0].sector_description).toBe('Buget local');
      expect(body.data.budgetSectors.pageInfo.totalCount).toBe(1);
    });

    it('filters by sector_ids', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(filter: { sector_ids: ["1", "3"] }) {
            nodes { sector_id }
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

      expect(body.data.budgetSectors.nodes).toHaveLength(2);
      const nodes = body.data.budgetSectors.nodes as { sector_id: string }[];
      const sectorIds = nodes.map((n) => n.sector_id);
      expect(sectorIds).toContain('1');
      expect(sectorIds).toContain('3');
      expect(body.data.budgetSectors.pageInfo.totalCount).toBe(2);
    });

    it('combines search and sector_ids filters', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(filter: { search: "buget", sector_ids: ["1", "2"] }) {
            nodes { sector_id sector_description }
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

      // Should match "Buget local" (id 1) and "Buget de stat" (id 2)
      expect(body.data.budgetSectors.nodes).toHaveLength(2);
    });

    it('returns empty when search matches nothing', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(filter: { search: "nonexistent" }) {
            nodes { sector_id }
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

      expect(body.data.budgetSectors.nodes).toHaveLength(0);
      expect(body.data.budgetSectors.pageInfo.totalCount).toBe(0);
    });

    it('filters out invalid IDs from sector_ids', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(filter: { sector_ids: ["1", "abc", "-5", "2"] }) {
            nodes { sector_id }
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

      // Should only include valid IDs 1 and 2
      expect(body.data.budgetSectors.nodes).toHaveLength(2);
    });

    it('returns all sectors when all IDs in sector_ids are invalid', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          budgetSectorRepo: makeFakeBudgetSectorRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          budgetSectors(filter: { sector_ids: ["abc", "-5", "xyz"] }) {
            nodes { sector_id }
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

      // When all IDs are invalid, filter is ignored - returns all 4 default sectors
      expect(body.data.budgetSectors.nodes).toHaveLength(4);
      expect(body.data.budgetSectors.pageInfo.totalCount).toBe(4);
    });
  });
});
