/**
 * County Analytics GraphQL Resolvers
 *
 * Handles the heatmapCountyData query, mapping GraphQL types to domain types
 * and orchestrating the use-case.
 * Includes field resolver for county_entity.
 */

import { Frequency } from '@/common/types/temporal.js';

import { getCountyHeatmapData } from '../../core/usecases/get-county-heatmap-data.js';

import type { CountyAnalyticsRepository } from '../../core/ports.js';
import type {
  NormalizedCountyHeatmapDataPoint,
  CountyHeatmapTransformationOptions,
} from '../../core/types.js';
import type {
  AnalyticsFilter,
  GqlReportPeriodInput,
  PeriodType,
} from '@/common/types/analytics.js';
import type { EntityRepository } from '@/modules/entity/core/ports.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { HeatmapCurrency } from '@/modules/uat-analytics/core/types.js';
import type { IResolvers } from 'mercurius';

// ============================================================================
// Types
// ============================================================================

/**
 * Dependencies for county analytics resolvers.
 */
export interface MakeCountyAnalyticsResolversDeps {
  repo: CountyAnalyticsRepository;
  normalizationService: NormalizationService;
  entityRepo: EntityRepository;
}

/**
 * GraphQL normalization mode (includes legacy euro modes for backwards compatibility).
 */
type GqlHeatmapNormalization = 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro';

/**
 * GraphQL filter input type (uses PeriodType enum with MONTH/QUARTER/YEAR).
 * May include normalization for backwards compatibility with clients that send it inside filter.
 */
interface GqlAnalyticsFilterInput extends Omit<AnalyticsFilter, 'report_period'> {
  report_period: GqlReportPeriodInput;
  // Backwards compatibility: some clients send normalization inside filter
  normalization?: GqlHeatmapNormalization | null;
  currency?: 'RON' | 'EUR' | null;
  inflation_adjusted?: boolean | null;
}

/**
 * GraphQL output type for county heatmap data point.
 * Includes county_entity_cui for field resolver (not exposed in schema).
 */
interface GqlHeatmapCountyDataPoint extends Omit<
  NormalizedCountyHeatmapDataPoint,
  'county_entity_cui'
> {
  county_entity_cui: string | null;
}

/**
 * GraphQL query arguments for heatmapCountyData.
 */
interface HeatmapCountyDataArgs {
  filter: GqlAnalyticsFilterInput;
  normalization?: GqlHeatmapNormalization | null;
  currency?: 'RON' | 'EUR' | null;
  inflation_adjusted?: boolean | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Maps GraphQL PeriodType to internal Frequency.
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
 * Converts GraphQL filter input to internal AnalyticsFilter.
 */
const toAnalyticsFilter = (gqlFilter: GqlAnalyticsFilterInput): AnalyticsFilter => {
  const { report_period: gqlReportPeriod, ...restFilter } = gqlFilter;

  return {
    ...restFilter,
    report_period: {
      type: mapPeriodTypeToFrequency(gqlReportPeriod.type),
      selection: gqlReportPeriod.selection,
    },
  };
};

/**
 * Maps GraphQL arguments to CountyHeatmapTransformationOptions.
 *
 * Handles legacy modes (total_euro, per_capita_euro) for backwards compatibility.
 * Also checks filter object for normalization params (backwards compatibility with clients
 * that send normalization inside filter).
 */
const toTransformationOptions = (
  args: HeatmapCountyDataArgs
): CountyHeatmapTransformationOptions => {
  // Check both root-level args and filter object (backwards compatibility)
  const normalization = args.normalization ?? args.filter.normalization;
  const currency = args.currency ?? args.filter.currency;
  const inflationAdjusted = args.inflation_adjusted ?? args.filter.inflation_adjusted ?? false;

  // Handle legacy euro modes
  const isLegacyEuroMode = normalization === 'total_euro' || normalization === 'per_capita_euro';
  const isPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';

  return {
    inflationAdjusted,
    // Legacy euro modes override the currency parameter
    currency: isLegacyEuroMode ? 'EUR' : ((currency ?? 'RON') as HeatmapCurrency),
    perCapita: isPerCapita,
  };
};

/**
 * Converts internal data point to GraphQL output type.
 */
const toGqlDataPoint = (point: NormalizedCountyHeatmapDataPoint): GqlHeatmapCountyDataPoint => ({
  ...point,
});

// ============================================================================
// Resolver Factory
// ============================================================================

/**
 * Creates county analytics resolvers.
 */
export const makeCountyAnalyticsResolvers = (
  deps: MakeCountyAnalyticsResolversDeps
): IResolvers => {
  const { repo, normalizationService, entityRepo } = deps;

  return {
    Query: {
      heatmapCountyData: async (
        _: unknown,
        args: HeatmapCountyDataArgs
      ): Promise<GqlHeatmapCountyDataPoint[]> => {
        // Convert GraphQL input to domain types
        const filter = toAnalyticsFilter(args.filter);
        const options = toTransformationOptions(args);

        // Execute use-case
        const result = await getCountyHeatmapData(
          { repo, normalizationService },
          { filter, options }
        );

        if (result.isErr()) {
          const error = result.error;
          switch (error.type) {
            case 'MISSING_REQUIRED_FILTER':
              throw new Error(`Missing required filter: ${error.field}`);
            case 'INVALID_PERIOD':
              throw new Error(`Invalid period: ${error.message}`);
            case 'NORMALIZATION_ERROR':
              throw new Error(`Normalization failed: ${error.message}`);
            case 'DATABASE_ERROR':
              throw new Error('An error occurred while fetching county heatmap data');
            default:
              throw new Error('An unexpected error occurred');
          }
        }

        // Convert to GraphQL output types
        return result.value.map(toGqlDataPoint);
      },
    },

    // Field resolver for county_entity
    HeatmapCountyDataPoint: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name uses snake_case
      county_entity: async (parent: GqlHeatmapCountyDataPoint) => {
        // Use the county_code to get the county entity
        const result = await entityRepo.getCountyEntity(parent.county_code);

        if (result.isErr()) {
          // Log error but return null (don't fail the whole query)
          return null;
        }

        return result.value;
      },
    },
  };
};
