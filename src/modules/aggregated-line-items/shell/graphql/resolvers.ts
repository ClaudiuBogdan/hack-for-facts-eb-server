import { Frequency } from '@/common/types/temporal.js';

import {
  getAggregatedLineItems,
  type GetAggregatedLineItemsDeps,
} from '../../core/usecases/get-aggregated-line-items.js';

import type {
  GqlAggregatedLineItemsInput,
  AggregatedLineItemsInput,
  NormalizationMode,
  Currency,
  LegacyNormalizationMode,
} from '../../core/types.js';
import type { PeriodType } from '@/common/types/analytics.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// -----------------------------------------
// Mapping Functions
// -----------------------------------------

/**
 * Maps GraphQL PeriodType (MONTH/QUARTER/YEAR) to internal Frequency enum.
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
 * Maps legacy normalization mode to strict mode + currency.
 */
const mapNormalizationMode = (
  legacyMode: LegacyNormalizationMode | undefined,
  inputCurrency: Currency | undefined
): { normalization: NormalizationMode; currency: Currency } => {
  if (legacyMode === 'total_euro') {
    return { normalization: 'total', currency: 'EUR' };
  }
  if (legacyMode === 'per_capita_euro') {
    return { normalization: 'per_capita', currency: 'EUR' };
  }

  // For non-legacy modes, use as-is
  const normalization: NormalizationMode =
    legacyMode === 'total' || legacyMode === 'per_capita' || legacyMode === 'percent_gdp'
      ? legacyMode
      : 'total';

  return {
    normalization,
    currency: inputCurrency ?? 'RON',
  };
};

/**
 * Converts GraphQL input to internal domain input.
 *
 * Handles:
 * - PeriodType -> Frequency mapping
 * - Legacy normalization modes (total_euro -> total + EUR)
 */
const toAggregatedLineItemsInput = (
  gqlFilter: GqlAggregatedLineItemsInput['filter'],
  limit?: number,
  offset?: number
): AggregatedLineItemsInput => {
  const { report_period: gqlReportPeriod, ...restFilter } = gqlFilter;

  // Map legacy normalization modes
  const { normalization, currency } = mapNormalizationMode(
    gqlFilter.normalization,
    gqlFilter.currency
  );

  const result: AggregatedLineItemsInput = {
    filter: {
      ...restFilter,
      report_period: {
        frequency: mapPeriodTypeToFrequency(gqlReportPeriod.type),
        selection: gqlReportPeriod.selection,
      },
      normalization,
      currency,
      inflation_adjusted: gqlFilter.inflation_adjusted ?? false,
      show_period_growth: gqlFilter.show_period_growth ?? false,
    },
  };

  if (limit !== undefined) {
    result.limit = limit;
  }
  if (offset !== undefined) {
    result.offset = offset;
  }

  return result;
};

// -----------------------------------------
// Resolver Factory
// -----------------------------------------

export type MakeAggregatedLineItemsResolversDeps = GetAggregatedLineItemsDeps;

/**
 * Creates GraphQL resolvers for the aggregatedLineItems endpoint.
 */
export const makeAggregatedLineItemsResolvers = (
  deps: MakeAggregatedLineItemsResolversDeps
): IResolvers => {
  return {
    Query: {
      aggregatedLineItems: async (
        _: unknown,
        args: {
          filter: GqlAggregatedLineItemsInput['filter'];
          limit?: number;
          offset?: number;
        },
        context: MercuriusContext
      ) => {
        const input = toAggregatedLineItemsInput(args.filter, args.limit, args.offset);

        const result = await getAggregatedLineItems(deps, input);

        if (result.isErr()) {
          const error = result.error;

          // Log error with request context
          context.reply.log.error(
            {
              err: error,
              errorType: error.type,
              filter: {
                account_category: input.filter.account_category,
                report_period: input.filter.report_period,
                normalization: input.filter.normalization,
              },
            },
            `[${error.type}] ${error.message}`
          );

          // Throw GraphQL error
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return result.value;
      },
    },
  };
};
