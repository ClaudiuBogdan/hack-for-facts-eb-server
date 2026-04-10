import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { describe, expect, it, afterAll, beforeEach } from 'vitest';

import {
  makeAdvancedMapAnalyticsGroupedSeriesRoutes,
  makeDbAdvancedMapAnalyticsGroupedSeriesProvider,
  type GroupedSeriesProvider,
} from '@/modules/advanced-map-analytics/index.js';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type { AdvancedMapDatasetRepository } from '@/modules/advanced-map-datasets/index.js';
import type { CommitmentsRepository } from '@/modules/commitments/index.js';
import type { InsRepository } from '@/modules/ins/index.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { UATAnalyticsRepository } from '@/modules/uat-analytics/index.js';

const requestBody = {
  granularity: 'UAT' as const,
  series: [
    {
      id: 's1',
      type: 'line-items-aggregated-yearly' as const,
      filter: {
        account_category: 'ch',
        report_type: 'Executie bugetara agregata la nivel de ordonator principal',
        report_period: {
          type: 'YEAR',
          selection: {
            interval: {
              start: '2025',
              end: '2025',
            },
          },
        },
      },
    },
    {
      id: 's2',
      type: 'commitments-analytics' as const,
      metric: 'CREDITE_ANGAJAMENT',
      filter: {
        report_period: {
          type: 'YEAR',
          selection: {
            interval: {
              start: '2025',
              end: '2025',
            },
          },
        },
      },
    },
  ],
  payload: {
    format: 'csv_wide_matrix_v1' as const,
    compression: 'none' as const,
  },
};

function makeProvider(): GroupedSeriesProvider {
  return {
    fetchGroupedSeriesVectors: async (request) =>
      ok({
        sirutaUniverse: ['1001', '1002', '1003'],
        vectors: request.series.map((series, index) => ({
          seriesId: series.id,
          unit: 'RON',
          valuesBySirutaCode:
            index === 0
              ? new Map([
                  ['1002', 2],
                  ['1001', 1],
                ])
              : new Map([['1002', 20]]),
        })),
        warnings: [],
      }),
  };
}

function makeBudgetDb(sirutaCodes: string[]): BudgetDbClient {
  const query = {
    select: () => ({
      where: () => ({
        orderBy: () => ({
          execute: async () =>
            sirutaCodes.map((sirutaCode) => ({
              siruta_code: sirutaCode,
            })),
        }),
      }),
    }),
  };

  return {
    selectFrom: () => query,
  } as unknown as BudgetDbClient;
}

const createTestApp = async (provider: GroupedSeriesProvider) => {
  const app = fastifyLib({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; name?: string; message?: string };
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    void reply.status(statusCode).send({
      ok: false,
      error: error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
    });
  });

  await app.register(
    makeAdvancedMapAnalyticsGroupedSeriesRoutes({
      groupedSeriesProvider: provider,
    })
  );

  await app.ready();

  return app;
};

describe('Advanced Map Analytics REST API', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app !== undefined) {
      await app.close();
    }

    app = await createTestApp(makeProvider());
  });

  it('returns wide matrix csv without authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/grouped-series',
      headers: {
        'content-type': 'application/json',
      },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      data: {
        manifest: {
          format: string;
        };
        payload: {
          data: string;
        };
      };
    }>();
    const csvData = body.data.payload.data;

    expect(body.ok).toBe(true);
    expect(body.data.manifest.format).toBe('wide_matrix_v1');
    expect(csvData.startsWith('siruta_code,s1,s2\n')).toBe(true);
  });

  it('generates safe series ids when the client omits them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/grouped-series',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        ...requestBody,
        series: requestBody.series.map(({ id: _id, ...series }) => series),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      data: {
        manifest: {
          series: { series_id: string }[];
        };
        payload: {
          data: string;
        };
      };
    }>();
    const csvData = body.data.payload.data;

    expect(body.ok).toBe(true);
    expect(body.data.manifest.series.map((item) => item.series_id)).toEqual([
      'series_1',
      'series_2',
    ]);
    expect(csvData.startsWith('siruta_code,series_1,series_2\n')).toBe(true);
  });

  it('returns a deduplicated validation message for invalid series payloads', async () => {
    const invalidBody = {
      ...requestBody,
      series: [
        {
          type: 'line-items-aggregated-yearly' as const,
        },
      ],
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/grouped-series',
      headers: {
        'content-type': 'application/json',
      },
      payload: invalidBody,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      message: "body/series/0 must have required property 'filter'",
    });
  });

  it('serializes non-projectable uploaded numeric values as null cells', async () => {
    if (app !== undefined) {
      await app.close();
    }

    const datasetRepo: AdvancedMapDatasetRepository = {
      createDataset: async () => {
        throw new Error('Not implemented');
      },
      getDatasetForUser: async () => {
        throw new Error('Not implemented');
      },
      listDatasetsForUser: async () => {
        throw new Error('Not implemented');
      },
      updateDatasetMetadata: async () => {
        throw new Error('Not implemented');
      },
      replaceDatasetRows: async () => {
        throw new Error('Not implemented');
      },
      softDeleteDataset: async () => {
        throw new Error('Not implemented');
      },
      listPublicDatasets: async () => {
        throw new Error('Not implemented');
      },
      getPublicDatasetByPublicId: async () => {
        throw new Error('Not implemented');
      },
      getShareableDatasetHeadById: async () => {
        throw new Error('Not implemented');
      },
      getAccessibleDatasetHead: async () => {
        throw new Error('Not implemented');
      },
      getAccessibleDataset: async () =>
        ok({
          id: 'dataset-1',
          publicId: '11111111-1111-4111-8111-111111111111',
          userId: 'user-1',
          title: 'Dataset',
          description: null,
          markdown: null,
          unit: 'RON',
          visibility: 'public',
          rowCount: 1,
          replacedAt: null,
          createdAt: new Date('2026-04-09T07:00:00.000Z'),
          updatedAt: new Date('2026-04-09T07:00:00.000Z'),
          rows: [{ sirutaCode: '1001', valueNumber: '9007199254740993', valueJson: null }],
        }),
      listDatasetRows: async () => ok([]),
      listReferencingMaps: async () => ok([]),
      listPublicReferencingMaps: async () => ok([]),
    };

    app = await createTestApp(
      makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
        budgetDb: makeBudgetDb(['1001']),
        datasetRepo,
        commitmentsRepo: {} as unknown as CommitmentsRepository,
        insRepo: {} as unknown as InsRepository,
        normalizationService: {} as unknown as NormalizationService,
        uatAnalyticsRepo: {} as unknown as UATAnalyticsRepository,
      })
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/grouped-series',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        granularity: 'UAT',
        series: [
          {
            id: 'uploaded_1',
            type: 'uploaded-map-dataset',
            datasetPublicId: '11111111-1111-4111-8111-111111111111',
          },
        ],
        payload: {
          format: 'csv_wide_matrix_v1',
          compression: 'none',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{
        data: {
          payload: {
            data: string;
          };
        };
      }>().data.payload.data
    ).toBe('siruta_code,uploaded_1\n1001,null');
  });

  it('uses only valueNumber from uploaded datasets and ignores valueJson', async () => {
    if (app !== undefined) {
      await app.close();
    }

    const datasetRepo: AdvancedMapDatasetRepository = {
      createDataset: async () => {
        throw new Error('Not implemented');
      },
      getDatasetForUser: async () => {
        throw new Error('Not implemented');
      },
      listDatasetsForUser: async () => {
        throw new Error('Not implemented');
      },
      updateDatasetMetadata: async () => {
        throw new Error('Not implemented');
      },
      replaceDatasetRows: async () => {
        throw new Error('Not implemented');
      },
      softDeleteDataset: async () => {
        throw new Error('Not implemented');
      },
      listPublicDatasets: async () => {
        throw new Error('Not implemented');
      },
      getPublicDatasetByPublicId: async () => {
        throw new Error('Not implemented');
      },
      getShareableDatasetHeadById: async () => {
        throw new Error('Not implemented');
      },
      getAccessibleDatasetHead: async () => {
        throw new Error('Not implemented');
      },
      getAccessibleDataset: async () =>
        ok({
          id: 'dataset-1',
          publicId: '11111111-1111-4111-8111-111111111111',
          userId: 'user-1',
          title: 'Dataset',
          description: null,
          markdown: null,
          unit: 'RON',
          visibility: 'public',
          rowCount: 1,
          replacedAt: null,
          createdAt: new Date('2026-04-09T07:00:00.000Z'),
          updatedAt: new Date('2026-04-09T07:00:00.000Z'),
          rows: [
            {
              sirutaCode: '1001',
              valueNumber: '7',
              valueJson: {
                type: 'text',
                value: {
                  text: 'commentary',
                },
              },
            },
          ],
        }),
      listDatasetRows: async () => ok([]),
      listReferencingMaps: async () => ok([]),
      listPublicReferencingMaps: async () => ok([]),
    };

    app = await createTestApp(
      makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
        budgetDb: makeBudgetDb(['1001']),
        datasetRepo,
        commitmentsRepo: {} as unknown as CommitmentsRepository,
        insRepo: {} as unknown as InsRepository,
        normalizationService: {} as unknown as NormalizationService,
        uatAnalyticsRepo: {} as unknown as UATAnalyticsRepository,
      })
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/grouped-series',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        granularity: 'UAT',
        series: [
          {
            id: 'uploaded_1',
            type: 'uploaded-map-dataset',
            datasetPublicId: '11111111-1111-4111-8111-111111111111',
          },
        ],
        payload: {
          format: 'csv_wide_matrix_v1',
          compression: 'none',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{
        data: {
          payload: {
            data: string;
          };
        };
      }>().data.payload.data
    ).toBe('siruta_code,uploaded_1\n1001,7');
  });
});
