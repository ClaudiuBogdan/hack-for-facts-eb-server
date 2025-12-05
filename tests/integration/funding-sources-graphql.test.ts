/**
 * Integration tests for Funding Source GraphQL API.
 */

import { describe, expect, it, afterEach } from 'vitest';

import { createApp } from '@/app/build-app.js';

import { makeTestConfig } from '../fixtures/builders.js';
import {
  makeFakeBudgetDb,
  makeFakeDatasetRepo,
  makeFakeFundingSourceRepo,
  makeFakeExecutionLineItemRepo,
} from '../fixtures/fakes.js';

import type { FundingSource } from '@/modules/funding-sources/index.js';
import type { FastifyInstance } from 'fastify';

describe('Funding Source GraphQL API', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  describe('fundingSource query', () => {
    it('returns source when found', async () => {
      const sources: FundingSource[] = [
        { source_id: 1, source_description: 'Buget de stat' },
        { source_id: 2, source_description: 'Fonduri externe' },
      ];

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo({ sources }),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "1") {
            source_id
            source_description
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
      expect(body.data.fundingSource).toEqual({
        source_id: '1',
        source_description: 'Buget de stat',
      });
    });

    it('returns null for non-existent ID', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo({ sources: [] }),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "999") {
            source_id
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
      expect(body.data.fundingSource).toBeNull();
    });

    it('returns null for invalid ID (non-numeric)', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "abc") {
            source_id
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
      expect(body.data.fundingSource).toBeNull();
    });

    it('returns null for negative ID', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "-1") {
            source_id
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
      expect(body.data.fundingSource).toBeNull();
    });
  });

  describe('fundingSources query', () => {
    it('returns all sources with default pagination', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources {
            nodes {
              source_id
              source_description
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

      // Default fake has 4 sources
      expect(body.data.fundingSources.nodes).toHaveLength(4);
      expect(body.data.fundingSources.pageInfo.totalCount).toBe(4);
      expect(body.data.fundingSources.pageInfo.hasNextPage).toBe(false);
      expect(body.data.fundingSources.pageInfo.hasPreviousPage).toBe(false);
    });

    it('supports pagination with limit and offset', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources(limit: 2, offset: 0) {
            nodes { source_id }
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

      expect(body.data.fundingSources.nodes).toHaveLength(2);
      expect(body.data.fundingSources.pageInfo.totalCount).toBe(4);
      expect(body.data.fundingSources.pageInfo.hasNextPage).toBe(true);
      expect(body.data.fundingSources.pageInfo.hasPreviousPage).toBe(false);
    });

    it('respects offset in pagination', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources(limit: 2, offset: 2) {
            nodes { source_id }
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

      expect(body.data.fundingSources.nodes).toHaveLength(2);
      expect(body.data.fundingSources.pageInfo.hasNextPage).toBe(false);
      expect(body.data.fundingSources.pageInfo.hasPreviousPage).toBe(true);
    });

    it('filters by search term', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources(filter: { search: "externe" }) {
            nodes {
              source_id
              source_description
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

      // "Fonduri externe nerambursabile" and "Credite externe"
      expect(body.data.fundingSources.nodes).toHaveLength(2);
      expect(body.data.fundingSources.pageInfo.totalCount).toBe(2);
    });

    it('filters by source_ids', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources(filter: { source_ids: ["1", "3"] }) {
            nodes { source_id }
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

      expect(body.data.fundingSources.nodes).toHaveLength(2);
      const nodes = body.data.fundingSources.nodes as { source_id: string }[];
      const sourceIds = nodes.map((n) => n.source_id);
      expect(sourceIds).toContain('1');
      expect(sourceIds).toContain('3');
      expect(body.data.fundingSources.pageInfo.totalCount).toBe(2);
    });

    it('combines search and source_ids filters', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources(filter: { search: "externe", source_ids: ["2", "4"] }) {
            nodes { source_id source_description }
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

      // "Fonduri externe nerambursabile" (id 2) and "Credite externe" (id 4)
      expect(body.data.fundingSources.nodes).toHaveLength(2);
    });

    it('returns empty when search matches nothing', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources(filter: { search: "nonexistent" }) {
            nodes { source_id }
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

      expect(body.data.fundingSources.nodes).toHaveLength(0);
      expect(body.data.fundingSources.pageInfo.totalCount).toBe(0);
    });

    it('filters out invalid IDs from source_ids', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSources(filter: { source_ids: ["1", "abc", "-5", "2"] }) {
            nodes { source_id }
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
      expect(body.data.fundingSources.nodes).toHaveLength(2);
    });
  });

  describe('executionLineItems nested resolver', () => {
    it('returns execution line items for a funding source', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "1") {
            source_id
            executionLineItems {
              nodes {
                line_item_id
                report_id
                year
                month
                account_category
              }
              pageInfo {
                totalCount
                hasNextPage
              }
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

      // The fake returns 2 items for funding_source_id 1 or 2
      expect(body.data.fundingSource.executionLineItems.nodes).toHaveLength(2);
      expect(body.data.fundingSource.executionLineItems.pageInfo.totalCount).toBe(2);
    });

    it('filters execution line items by account_category', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "1") {
            source_id
            executionLineItems(accountCategory: ch) {
              nodes {
                line_item_id
                account_category
              }
              pageInfo { totalCount }
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

      // Only 1 item has account_category = 'ch'
      expect(body.data.fundingSource.executionLineItems.nodes).toHaveLength(1);
      expect(body.data.fundingSource.executionLineItems.nodes[0].account_category).toBe('ch');
    });

    it('returns empty for funding source with no line items', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "3") {
            source_id
            executionLineItems {
              nodes { line_item_id }
              pageInfo { totalCount }
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

      // Fake returns empty for funding_source_id 3
      expect(body.data.fundingSource.executionLineItems.nodes).toHaveLength(0);
      expect(body.data.fundingSource.executionLineItems.pageInfo.totalCount).toBe(0);
    });

    it('supports pagination for execution line items', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          fundingSourceRepo: makeFakeFundingSourceRepo(),
          executionLineItemRepo: makeFakeExecutionLineItemRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          fundingSource(id: "1") {
            executionLineItems(limit: 1, offset: 0) {
              nodes { line_item_id }
              pageInfo {
                totalCount
                hasNextPage
                hasPreviousPage
              }
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

      expect(body.data.fundingSource.executionLineItems.nodes).toHaveLength(1);
      expect(body.data.fundingSource.executionLineItems.pageInfo.totalCount).toBe(2);
      expect(body.data.fundingSource.executionLineItems.pageInfo.hasNextPage).toBe(true);
      expect(body.data.fundingSource.executionLineItems.pageInfo.hasPreviousPage).toBe(false);
    });
  });
});
