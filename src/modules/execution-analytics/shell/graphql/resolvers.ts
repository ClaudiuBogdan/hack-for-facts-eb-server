import {
  Frequency,
  type AnalyticsInput,
  type GqlAnalyticsInput,
  type PeriodType,
} from '../../core/types.js';
import {
  getAnalyticsSeries,
  type GetAnalyticsSeriesDeps,
} from '../../core/usecases/get-analytics-series.js';

import type { IResolvers } from 'mercurius';

/**
 * Maps GraphQL PeriodType (MONTH/QUARTER/YEAR) to internal Frequency (MONTHLY/QUARTERLY/YEARLY)
 */
const mapPeriodTypeToFrequency = (periodType: PeriodType): Frequency => {
  switch (periodType) {
    case 'MONTH':
      return Frequency.MONTH;
    case 'QUARTER':
      return Frequency.QUARTER;
    case 'YEAR':
      return Frequency.YEAR;
  }
};

/**
 * Converts GraphQL input to internal AnalyticsInput
 */
const toAnalyticsInput = (gqlInput: GqlAnalyticsInput): AnalyticsInput => {
  const { filter, seriesId } = gqlInput;
  const gqlReportPeriod = filter.report_period;

  // Build filter without report_period, then add the transformed version
  const baseFilter = { ...filter };
  delete (baseFilter as Record<string, unknown>)['report_period'];

  const result: AnalyticsInput = {
    filter: {
      ...baseFilter,
      report_period: {
        frequency: mapPeriodTypeToFrequency(gqlReportPeriod.type),
        selection: gqlReportPeriod.selection,
      },
    },
  };

  if (seriesId !== undefined) {
    result.seriesId = seriesId;
  }

  return result;
};

export const makeExecutionAnalyticsResolvers = (deps: GetAnalyticsSeriesDeps): IResolvers => {
  return {
    PeriodDate: {
      // Simple scalar implementation, treating as string for now
      serialize: (value: unknown) => value,
      parseValue: (value: unknown) => value,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Accessing AST value without full AST type definition */
      parseLiteral: (ast: any) => ast.value,
    },
    Query: {
      executionAnalytics: async (_: unknown, { inputs }: { inputs: GqlAnalyticsInput[] }) => {
        // Map GraphQL inputs to internal domain types
        const domainInputs = inputs.map(toAnalyticsInput);
        const result = await getAnalyticsSeries(deps, domainInputs);
        if (result.isErr()) {
          throw new Error(result.error.message);
        }
        return result.value;
      },
    },
  };
};
