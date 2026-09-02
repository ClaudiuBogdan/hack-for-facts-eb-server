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
import {
  listLegacyBudgetSectors,
  listLegacyClassifications,
  listLegacyFundingSources,
  type LegacyClassificationOptions,
} from '../../../core/legacy-dimensions/usecases.js';

import type {
  LegacyAnalyticsInput,
  LegacyAnalyticsSeries,
} from '../../../core/legacy-analytics/types.js';
import type { LegacyDimensionRepo } from '../../../core/legacy-dimensions/ports.js';
import type {
  LegacyClassificationPageInput,
  LegacyDimensionPageInput,
} from '../../../core/legacy-dimensions/types.js';
import type { Result } from 'neverthrow';

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

export interface BudgetLegacyResolverDeps extends LegacyExecutionSeriesDeps {
  /** The four dimension roots (design 13 §4 "dimension usecases"). */
  readonly dimensions: LegacyDimensionRepo;
  /** Fired when a classification list was clamped below the requested limit (never silent). */
  readonly onClassificationClamped?: LegacyClassificationOptions['onClamped'];
}

interface LegacyDimensionArgs {
  filter?: {
    search?: string | null;
    sector_ids?: string[] | null;
    source_ids?: string[] | null;
  } | null;
  limit?: number | null;
  offset?: number | null;
}

interface LegacyClassificationArgs {
  filter?: {
    search?: string | null;
    functional_codes?: string[] | null;
    economic_codes?: string[] | null;
  } | null;
  limit?: number | null;
  offset?: number | null;
}

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

const pageInput = (
  args: LegacyDimensionArgs,
  ids: readonly string[] | null | undefined
): LegacyDimensionPageInput => ({
  search: args.filter?.search,
  ids,
  limit: args.limit,
  offset: args.offset,
});

const classificationInput = (
  args: LegacyClassificationArgs,
  codes: readonly string[] | null | undefined
): LegacyClassificationPageInput => ({
  search: args.filter?.search,
  codes,
  limit: args.limit,
  offset: args.offset,
});

export const makeBudgetLegacyResolvers = (
  deps: BudgetLegacyResolverDeps
): Record<string, unknown> => ({
  PeriodDate: PeriodDateScalar,
  ReportType: GQL_TO_DB_REPORT_TYPE,
  FundingSource: {
    /**
     * Carried for SDL identity, not served: no client document sends it and the
     * kernel's line-item path requires the year / report type / account category
     * triple this field never carried (user decision S1-11; portable on request).
     */
    executionLineItems: (): never => {
      throw new GraphQLError(
        'FundingSource.executionLineItems is not served on this endpoint (design 13 §2: never sent by the client)',
        { extensions: { code: 'NOT_PORTED', type: 'NotPorted' } }
      );
    },
  },
  Query: {
    executionAnalytics: async (
      _parent: unknown,
      args: { inputs: readonly LegacyAnalyticsInput[] }
    ): Promise<GraphqlAnalyticsSeries[]> => {
      const result = await legacyExecutionSeries(deps, args.inputs);
      if (result.isErr()) throw toGraphqlError(result.error);
      return result.value.map(toGraphqlSeries);
    },
    budgetSectors: async (_parent: unknown, args: LegacyDimensionArgs) =>
      unwrap(
        await listLegacyBudgetSectors(deps.dimensions, pageInput(args, args.filter?.sector_ids))
      ),
    fundingSources: async (_parent: unknown, args: LegacyDimensionArgs) =>
      unwrap(
        await listLegacyFundingSources(deps.dimensions, pageInput(args, args.filter?.source_ids))
      ),
    functionalClassifications: async (_parent: unknown, args: LegacyClassificationArgs) => {
      const page = unwrap(
        await listLegacyClassifications(
          deps.dimensions,
          'functional',
          classificationInput(args, args.filter?.functional_codes),
          deps.onClassificationClamped === undefined
            ? {}
            : { onClamped: deps.onClassificationClamped }
        )
      );
      return {
        nodes: page.nodes.map((n) => ({ functional_code: n.code, functional_name: n.name })),
        pageInfo: page.pageInfo,
      };
    },
    economicClassifications: async (_parent: unknown, args: LegacyClassificationArgs) => {
      const page = unwrap(
        await listLegacyClassifications(
          deps.dimensions,
          'economic',
          classificationInput(args, args.filter?.economic_codes),
          deps.onClassificationClamped === undefined
            ? {}
            : { onClamped: deps.onClassificationClamped }
        )
      );
      return {
        nodes: page.nodes.map((n) => ({ economic_code: n.code, economic_name: n.name })),
        pageInfo: page.pageInfo,
      };
    },
  },
});
