import { Frequency } from '@/common/types/temporal.js';

import {
  getEntityAnalytics,
  type GetEntityAnalyticsDeps,
} from '../../core/usecases/get-entity-analytics.js';

import type {
  GqlEntityAnalyticsInput,
  EntityAnalyticsInput,
  EntityAnalyticsSort,
  EntityAnalyticsSortField,
  NormalizationMode,
  Currency,
  LegacyNormalizationMode,
} from '../../core/types.js';
import type { PeriodType } from '@/common/types/analytics.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

/**
 * GraphQL SortOrder input type (common type from infra/graphql/common/types.ts)
 */
interface GqlSortOrder {
  by: string;
  order: string;
}

// -----------------------------------------
// Mapping Functions
// -----------------------------------------

/** Valid sort fields for entity analytics */
const VALID_SORT_FIELDS = new Set<EntityAnalyticsSortField>([
  'AMOUNT',
  'TOTAL_AMOUNT',
  'PER_CAPITA_AMOUNT',
  'ENTITY_NAME',
  'ENTITY_TYPE',
  'POPULATION',
  'COUNTY_NAME',
  'COUNTY_CODE',
]);

/** Default sort: TOTAL_AMOUNT DESC */
const DEFAULT_SORT: EntityAnalyticsSort = {
  by: 'TOTAL_AMOUNT',
  order: 'DESC',
};

/**
 * Maps GraphQL SortOrder to internal EntityAnalyticsSort.
 * Returns DEFAULT_SORT if sort is not provided or invalid.
 */
const mapSortOrder = (gqlSort?: GqlSortOrder): EntityAnalyticsSort => {
  if (gqlSort === undefined) {
    return DEFAULT_SORT;
  }

  const sortField = gqlSort.by.toUpperCase() as EntityAnalyticsSortField;
  if (!VALID_SORT_FIELDS.has(sortField)) {
    // Invalid sort field - use default
    return DEFAULT_SORT;
  }

  const sortOrder = gqlSort.order.toUpperCase();
  if (sortOrder !== 'ASC' && sortOrder !== 'DESC') {
    return DEFAULT_SORT;
  }

  return {
    by: sortField,
    order: sortOrder,
  };
};

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
 * - Sort configuration
 */
const toEntityAnalyticsInput = (
  gqlFilter: GqlEntityAnalyticsInput['filter'],
  sort?: EntityAnalyticsSort,
  limit?: number,
  offset?: number
): EntityAnalyticsInput => {
  const { report_period: gqlReportPeriod, ...restFilter } = gqlFilter;

  // Map legacy normalization modes
  const { normalization, currency } = mapNormalizationMode(
    gqlFilter.normalization,
    gqlFilter.currency
  );

  const result: EntityAnalyticsInput = {
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

  if (sort !== undefined) {
    result.sort = sort;
  }
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

export type MakeEntityAnalyticsResolversDeps = GetEntityAnalyticsDeps;

/**
 * Creates GraphQL resolvers for the entityAnalytics endpoint.
 */
export const makeEntityAnalyticsResolvers = (
  deps: MakeEntityAnalyticsResolversDeps
): IResolvers => {
  return {
    Query: {
      entityAnalytics: async (
        _: unknown,
        args: {
          filter: GqlEntityAnalyticsInput['filter'];
          sort?: GqlSortOrder;
          limit?: number;
          offset?: number;
        },
        context: MercuriusContext
      ) => {
        const sort = mapSortOrder(args.sort);
        const input = toEntityAnalyticsInput(args.filter, sort, args.limit, args.offset);

        const result = await getEntityAnalytics(deps, input);

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
              sort: input.sort,
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
