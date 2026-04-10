/**
 * Advanced Map Analytics REST Routes
 */

import { isAuthenticated, type AuthContext } from '@/modules/auth/index.js';

import { mapGroupedSeriesBodyToRequest } from './map-request-mapper.js';
import {
  GroupedSeriesDataBodyInputSchema,
  GroupedSeriesDataResponseSchema,
  ErrorResponseSchema,
  type GroupedSeriesDataBodyInput,
} from './schemas.js';
import { serializeWideMatrixCsv } from './wide-csv.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { getGroupedSeriesData } from '../../core/usecases/get-grouped-series-data.js';

import type { GroupedSeriesProvider } from '../../core/ports.js';
import type { FastifyPluginAsync } from 'fastify';

export interface MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps {
  groupedSeriesProvider: GroupedSeriesProvider;
}

interface ValidationIssue {
  instancePath?: string;
  keyword?: string;
  params?: Record<string, unknown>;
  message?: string;
}

function formatGroupedSeriesSchemaError(errors: ValidationIssue[], dataVar: string): Error {
  const filteredErrors = errors.filter((error) => error.keyword !== 'anyOf');
  const relevantErrors = filteredErrors.length > 0 ? filteredErrors : errors;
  const messages: string[] = [];
  const seen = new Set<string>();

  for (const error of relevantErrors) {
    const path = `${dataVar}${error.instancePath ?? ''}`;
    let message: string;

    if (error.keyword === 'required' && typeof error.params?.['missingProperty'] === 'string') {
      message = `${path} must have required property '${error.params['missingProperty']}'`;
    } else {
      message = `${path} ${error.message ?? 'is invalid'}`;
    }

    if (!seen.has(message)) {
      seen.add(message);
      messages.push(message);
    }
  }

  return new Error(messages[0] ?? `${dataVar} is invalid`);
}

export const makeAdvancedMapAnalyticsGroupedSeriesRoutes = (
  deps: MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps
): FastifyPluginAsync => {
  const { groupedSeriesProvider } = deps;

  return (fastify) => {
    fastify.post<{ Body: GroupedSeriesDataBodyInput }>(
      '/api/v1/advanced-map-analytics/grouped-series',
      {
        schemaErrorFormatter: formatGroupedSeriesSchemaError,
        schema: {
          body: GroupedSeriesDataBodyInputSchema,
          response: {
            200: GroupedSeriesDataResponseSchema,
            400: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const authContext = (request as { auth?: AuthContext }).auth;
        const result = await getGroupedSeriesData(
          {
            provider: groupedSeriesProvider,
          },
          {
            request: {
              ...mapGroupedSeriesBodyToRequest(request.body),
              ...(authContext !== undefined && isAuthenticated(authContext)
                ? { requestUserId: authContext.userId }
                : {}),
            },
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 404 | 500).send({
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
