import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { describe, expect, it, afterAll, beforeEach } from 'vitest';

import {
  makeAdvancedMapAnalyticsGroupedSeriesRoutes,
  type GroupedSeriesProvider,
} from '@/modules/advanced-map-analytics/index.js';

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
    fetchGroupedSeriesVectors: async () =>
      ok({
        sirutaUniverse: ['1001', '1002', '1003'],
        vectors: [
          {
            seriesId: 's1',
            unit: 'RON',
            valuesBySirutaCode: new Map([
              ['1002', 2],
              ['1001', 1],
            ]),
          },
          {
            seriesId: 's2',
            unit: 'RON',
            valuesBySirutaCode: new Map([['1002', 20]]),
          },
        ],
        warnings: [],
      }),
  };
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
    const body = response.json();
    const csvData = String(body.data.payload.data);

    expect(body.ok).toBe(true);
    expect(body.data.manifest.format).toBe('wide_matrix_v1');
    expect(csvData.startsWith('siruta_code,s1,s2\n')).toBe(true);
  });
});
