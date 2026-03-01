/**
 * Advanced Map Analytics REST Routes
 */

import { Frequency } from '@/common/types/temporal.js';
import { isAuthenticated } from '@/modules/auth/index.js';
import { requireAuthHandler } from '@/modules/auth/shell/middleware/fastify-auth.js';

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
import type { MapRequestSeries } from '../../core/types.js';
import type { PeriodDate, ReportPeriodInput } from '@/common/types/analytics.js';
import type { FastifyPluginAsync } from 'fastify';

export interface MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps {
  groupedSeriesProvider: GroupedSeriesProvider;
  allowedUserIds: string[];
}

function isUserAllowlisted(allowedUserIds: Set<string>, userId: string): boolean {
  return allowedUserIds.has(userId);
}

function toFrequency(value: 'MONTH' | 'QUARTER' | 'YEAR'): Frequency {
  if (value === 'MONTH') {
    return Frequency.MONTH;
  }

  if (value === 'QUARTER') {
    return Frequency.QUARTER;
  }

  return Frequency.YEAR;
}

function toReportPeriodInput(period: {
  type: 'MONTH' | 'QUARTER' | 'YEAR';
  selection: { interval: { start: string; end: string } } | { dates: string[] };
}): ReportPeriodInput {
  const selection: ReportPeriodInput['selection'] =
    'interval' in period.selection
      ? {
          interval: {
            start: period.selection.interval.start as PeriodDate,
            end: period.selection.interval.end as PeriodDate,
          },
          dates: undefined,
        }
      : {
          dates: period.selection.dates as PeriodDate[],
          interval: undefined,
        };

  return {
    type: toFrequency(period.type),
    selection,
  };
}

function toMapRequestSeries(series: GroupedSeriesDataBody['series'][number]): MapRequestSeries {
  if (series.type === 'line-items-aggregated-yearly') {
    return {
      ...series,
      filter: {
        ...series.filter,
        report_period: toReportPeriodInput(series.filter.report_period),
      },
    };
  }

  if (series.type === 'commitments-analytics') {
    return {
      ...series,
      filter: {
        ...series.filter,
        report_period: toReportPeriodInput(series.filter.report_period),
      },
    };
  }

  const { period, ...rest } = series;
  return period !== undefined
    ? {
        ...rest,
        period: toReportPeriodInput(period),
      }
    : rest;
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
              granularity: request.body.granularity,
              series: request.body.series.map((series) => toMapRequestSeries(series)),
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
