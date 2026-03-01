/**
 * Advanced Map Analytics REST Routes
 */

import { isAuthenticated } from '@/modules/auth/index.js';
import { requireAuthHandler } from '@/modules/auth/shell/middleware/fastify-auth.js';

import { mapGroupedSeriesBodyToRequest } from './map-request-mapper.js';
import {
  GroupedSeriesDataBodySchema,
  GroupedSeriesDataResponseSchema,
  ErrorResponseSchema,
  type GroupedSeriesDataBody,
} from './schemas.js';
import { serializeWideMatrixCsv } from './wide-csv.js';
import {
  createForbiddenError,
  createUnauthorizedError,
  getHttpStatusForError,
} from '../../core/errors.js';
import { getGroupedSeriesData } from '../../core/usecases/get-grouped-series-data.js';

import type { GroupedSeriesProvider } from '../../core/ports.js';
import type { FastifyPluginAsync } from 'fastify';

export interface MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps {
  groupedSeriesProvider: GroupedSeriesProvider;
  allowedUserIds: string[];
}

function isUserAllowlisted(allowedUserIds: Set<string>, userId: string): boolean {
  return allowedUserIds.has(userId);
}

export const makeAdvancedMapAnalyticsGroupedSeriesRoutes = (
  deps: MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps
): FastifyPluginAsync => {
  const { groupedSeriesProvider } = deps;
  const allowedUserIds = new Set(
    deps.allowedUserIds.map((userId) => userId.trim()).filter((userId) => userId !== '')
  );

  return (fastify) => {
    fastify.post<{ Body: GroupedSeriesDataBody }>(
      '/api/v1/advanced-map-analytics/grouped-series',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: GroupedSeriesDataBodySchema,
          response: {
            200: GroupedSeriesDataResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          const unauthorized = createUnauthorizedError('Authentication required');
          return reply.status(401).send({
            ok: false,
            error: unauthorized.type,
            message: unauthorized.message,
          });
        }

        const userId = request.auth.userId as string;
        if (!isUserAllowlisted(allowedUserIds, userId)) {
          const forbidden = createForbiddenError('Access denied for this user');
          return reply.status(403).send({
            ok: false,
            error: forbidden.type,
            message: forbidden.message,
          });
        }

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
          return reply.status(status as 400 | 401 | 403 | 500).send({
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
