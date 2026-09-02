/**
 * Legacy `executionAnalytics` resolvers on the kernel endpoint (13 §3 rule 2:
 * thin — args → usecase → the legacy result shape; no SQL here).
 *
 *  - `PeriodDate` scalar: the legacy pass-through, same width as the legacy
 *    resolver (`execution-analytics/shell/graphql/resolvers.ts:67-73`).
 *  - `ReportType` enum value resolver: GraphQL name → the Romanian partition
 *    literal (legacy `EnumResolvers.ReportType`), so the resolver receives the
 *    literal exactly as the legacy resolver did.
 *  - `y` is converted `Decimal → Float` HERE, the only float in the path.
 *  - Errors: `ApiError` → `GraphQLError` with `extensions.code` (kernel style).
 */

import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

import { GQL_TO_DB_REPORT_TYPE } from '@/common/types/report-types.js';
import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import {
  legacyExecutionSeries,
  type LegacyExecutionSeriesDeps,
} from '../../../core/legacy-analytics/usecase.js';

import type {
  LegacyAnalyticsInput,
  LegacyAnalyticsSeries,
} from '../../../core/legacy-analytics/types.js';

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: {
      code: GRAPHQL_ERROR_CODE[error.type],
      type: error.type,
      ...(error.type === 'InvalidInput' && error.field !== undefined && { field: error.field }),
    },
  });

/**
 * The legacy `PeriodDate` implementation, width-identical
 * (`execution-analytics/shell/graphql/resolvers.ts:67-73`):
 *   serialize: (value) => value · parseValue: (value) => value ·
 *   parseLiteral: (ast) => ast.value
 * `ast.value` exists on STRING / INT / FLOAT / ENUM literals (the literal's
 * text) and on BOOLEAN (the boolean); LIST / OBJECT / NULL literals have no
 * `.value` → `undefined` → graphql rejects the literal, exactly as legacy did.
 * The one residual: legacy handed the raw boolean to `extractYear`
 * (`infra/database/query-filters/period-filter.ts:77-85`), which threw a
 * TypeError on `.length`; here it is stringified and, being unparseable, ends
 * as the documented bounded-years `InvalidInput`. No client sends a literal.
 */
export const PeriodDateScalar = new GraphQLScalarType({
  name: 'PeriodDate',
  description:
    'A string representing a Year (YYYY), Year-Month (YYYY-MM), or Year-Quarter (YYYY-Q[1-4])',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast) => {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.INT:
      case Kind.FLOAT:
      case Kind.ENUM:
        return ast.value;
      case Kind.BOOLEAN:
        return String(ast.value);
      default:
        return undefined;
    }
  },
});

export interface GraphqlAnalyticsSeries {
  readonly seriesId: string;
  readonly xAxis: LegacyAnalyticsSeries['xAxis'];
  readonly yAxis: LegacyAnalyticsSeries['yAxis'];
  readonly data: readonly { readonly x: string; readonly y: number }[];
}

/** Decimal → Float at the wire boundary (the legacy `AnalyticsDataPoint.y: Float!`). */
export const toGraphqlSeries = (series: LegacyAnalyticsSeries): GraphqlAnalyticsSeries => ({
  seriesId: series.seriesId,
  xAxis: series.xAxis,
  yAxis: series.yAxis,
  data: series.data.map((p) => ({ x: p.x, y: p.y.toNumber() })),
});

export const makeBudgetLegacyResolvers = (
  deps: LegacyExecutionSeriesDeps
): Record<string, unknown> => ({
  PeriodDate: PeriodDateScalar,
  ReportType: GQL_TO_DB_REPORT_TYPE,
  Query: {
    executionAnalytics: async (
      _parent: unknown,
      args: { inputs: readonly LegacyAnalyticsInput[] }
    ): Promise<GraphqlAnalyticsSeries[]> => {
      const result = await legacyExecutionSeries(deps, args.inputs);
      if (result.isErr()) throw toGraphqlError(result.error);
      return result.value.map(toGraphqlSeries);
    },
  },
});
