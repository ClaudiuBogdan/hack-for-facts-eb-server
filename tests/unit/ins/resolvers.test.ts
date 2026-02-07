import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { makeInsResolvers } from '@/modules/ins/shell/graphql/resolvers.js';

import type { InsRepository } from '@/modules/ins/core/ports.js';
import type { InsDimensionValueConnection } from '@/modules/ins/core/types.js';

function createFakeRepo(overrides: Partial<InsRepository> = {}): InsRepository {
  return {
    listDatasets: async () =>
      ok({
        nodes: [],
        pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
      }),
    listContexts: async () =>
      ok({
        nodes: [],
        pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
      }),
    getDatasetByCode: async () =>
      ok({
        id: 1,
        code: 'POP107D',
        name_ro: null,
        name_en: null,
        definition_ro: null,
        definition_en: null,
        periodicity: ['ANNUAL'],
        year_range: null,
        dimension_count: 1,
        has_uat_data: true,
        has_county_data: true,
        has_siruta: true,
        sync_status: null,
        last_sync_at: null,
        context_code: null,
        context_name_ro: null,
        context_name_en: null,
        context_path: null,
        metadata: null,
      }),
    listDimensions: async () =>
      ok([
        {
          matrix_id: 1,
          index: 2,
          type: 'CLASSIFICATION',
          label_ro: 'Sex',
          label_en: null,
          classification_type: null,
          is_hierarchical: false,
          option_count: 2,
        },
      ]),
    listDimensionValues: async () =>
      ok({
        nodes: [],
        pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
      }),
    listObservations: async () =>
      ok({
        nodes: [],
        pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
      }),
    listLatestDatasetValues: async () => ok([]),
    listUatDatasetsWithObservations: async () => ok([]),
    ...overrides,
  };
}

interface TestContext {
  reply: {
    log: {
      error: ReturnType<typeof vi.fn>;
    };
  };
}

function createContext(): TestContext {
  return {
    reply: {
      log: {
        error: vi.fn(),
      },
    },
  };
}

describe('INS resolvers', () => {
  it('resolves insDatasetDimensionValues with paging and search filter', async () => {
    let captured: {
      matrixId: number;
      dimIndex: number;
      limit: number;
      offset: number;
      filterSearch: string | undefined;
    } | null = null;

    const expectedConnection: InsDimensionValueConnection = {
      nodes: [
        {
          matrix_id: 1,
          dim_index: 2,
          nom_item_id: 10,
          dimension_type: 'CLASSIFICATION',
          label_ro: 'Masculin',
          label_en: null,
          parent_nom_item_id: null,
          offset_order: 1,
          territory: null,
          time_period: null,
          classification_value: null,
          unit: null,
        },
      ],
      pageInfo: { totalCount: 1, hasNextPage: false, hasPreviousPage: false },
    };

    const repo = createFakeRepo({
      listDimensionValues: async (matrixId, dimIndex, filter, limit, offset) => {
        captured = {
          matrixId,
          dimIndex,
          limit,
          offset,
          filterSearch: filter.search,
        };
        return ok(expectedConnection);
      },
    });

    const resolvers = makeInsResolvers({ insRepo: repo });
    const context = createContext();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- invoking GraphQL resolver in test
    const result = await (resolvers as any).Query.insDatasetDimensionValues(
      {},
      {
        datasetCode: 'POP107D',
        dimensionIndex: 2,
        filter: { search: 'masc' },
        limit: 25,
        offset: 50,
      },
      context
    );

    expect(result).toEqual(expectedConnection);
    if (captured === null) {
      throw new Error('Expected listDimensionValues to be called');
    }
    const capturedValue = captured as {
      matrixId: number;
      dimIndex: number;
      limit: number;
      offset: number;
      filterSearch: string | undefined;
    };
    expect(capturedValue.matrixId).toBe(1);
    expect(capturedValue.dimIndex).toBe(2);
    expect(capturedValue.limit).toBe(25);
    expect(capturedValue.offset).toBe(50);
    expect(capturedValue.filterSearch).toBe('masc');
  });

  it('returns empty connection when dataset code is unknown', async () => {
    let listDimensionValuesCalled = false;

    const repo = createFakeRepo({
      getDatasetByCode: async () => ok(null),
      listDimensionValues: async () => {
        listDimensionValuesCalled = true;
        return ok({
          nodes: [],
          pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
        });
      },
    });

    const resolvers = makeInsResolvers({ insRepo: repo });
    const context = createContext();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- invoking GraphQL resolver in test
    const result = await (resolvers as any).Query.insDatasetDimensionValues(
      {},
      {
        datasetCode: 'UNKNOWN',
        dimensionIndex: 1,
      },
      context
    );

    expect(result).toEqual({
      nodes: [],
      pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
    });
    expect(listDimensionValuesCalled).toBe(false);
  });

  it('returns InvalidFilterError for insObservations when period is null', async () => {
    let listObservationsCalled = false;

    const repo = createFakeRepo({
      listObservations: async () => {
        listObservationsCalled = true;
        return ok({
          nodes: [],
          pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
        });
      },
    });

    const resolvers = makeInsResolvers({ insRepo: repo });
    const context = createContext();

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- invoking GraphQL resolver in test
      (resolvers as any).Query.insObservations(
        {},
        { datasetCode: 'POP107D', filter: { period: null } },
        context
      )
    ).rejects.toThrow('[InvalidFilterError] Invalid period format');

    expect(listObservationsCalled).toBe(false);
    expect(context.reply.log.error).toHaveBeenCalledOnce();
  });
});
