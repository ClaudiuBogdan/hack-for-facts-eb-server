import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { describe, expect, it, afterAll, beforeEach } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import {
  makeExperimentalMapRoutes,
  type MapSeriesProvider,
} from '@/modules/experimental-map/index.js';

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

function makeProvider(): MapSeriesProvider {
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

const createTestApp = async (options: {
  allowedUserIds: string[];
  provider: MapSeriesProvider;
}) => {
  const testAuth = createTestAuthProvider();
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

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

  await app.register(
    makeExperimentalMapRoutes({
      mapSeriesProvider: options.provider,
      allowedUserIds: options.allowedUserIds,
    })
  );

  await app.ready();

  return {
    app,
    testAuth,
  };
};

describe('Experimental Map REST API', () => {
  let app: FastifyInstance;
  let testAuth: ReturnType<typeof createTestAuthProvider>;

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app !== undefined) {
      await app.close();
    }

    const testContext = await createTestApp({
      allowedUserIds: ['user_test_1'],
      provider: makeProvider(),
    });

    app = testContext.app;
    testAuth = testContext.testAuth;
  });

  it('returns 401 without authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/experimental/map/grouped-series',
      headers: {
        'content-type': 'application/json',
      },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('AuthenticationRequiredError');
  });

  it('returns 403 for authenticated but non-allowlisted users', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/experimental/map/grouped-series',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user2}`,
        'content-type': 'application/json',
      },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('ForbiddenError');
  });

  it('returns wide matrix csv for authenticated allowlisted users', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/experimental/map/grouped-series',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
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
