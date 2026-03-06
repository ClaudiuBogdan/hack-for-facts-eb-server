/**
 * Advanced Map Analytics REST Routes
 */

import { mapGroupedSeriesBodyToRequest } from './map-request-mapper.js';
import {
  GroupedSeriesDataBodySchema,
  GroupedSeriesDataResponseSchema,
  ErrorResponseSchema,
  type GroupedSeriesDataBody,
} from './schemas.js';
import { serializeWideMatrixCsv } from './wide-csv.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { getGroupedSeriesData } from '../../core/usecases/get-grouped-series-data.js';

import type { GroupedSeriesProvider } from '../../core/ports.js';
import type { FastifyPluginAsync } from 'fastify';

export interface MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps {
  groupedSeriesProvider: GroupedSeriesProvider;
}

export const makeAdvancedMapAnalyticsGroupedSeriesRoutes = (
  deps: MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps
): FastifyPluginAsync => {
  const { groupedSeriesProvider } = deps;

  return (fastify) => {
    fastify.post<{ Body: GroupedSeriesDataBody }>(
      '/api/v1/advanced-map-analytics/grouped-series',
      {
        schema: {
          body: GroupedSeriesDataBodySchema,
          response: {
            200: GroupedSeriesDataResponseSchema,
            400: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await getGroupedSeriesData(
          {
            provider: groupedSeriesProvider,
          },
          {
            request: {
              ...mapGroupedSeriesBodyToRequest(request.body),
            },
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        const csvData = serializeWideMatrixCsv(result.value.seriesOrder, result.value.rows);

        return reply.status(200).send({
          ok: true,
          data: {
            manifest: result.value.manifest,
            payload: {
              mime: 'text/csv',
              compression: 'none',
              data: csvData,
            },
            warnings: result.value.warnings,
          },
        });
      }
    );

    return Promise.resolve();
  };
};
