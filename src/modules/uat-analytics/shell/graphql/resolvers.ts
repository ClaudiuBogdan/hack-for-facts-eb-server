/**
 * UAT Analytics GraphQL Resolvers
 *
 * Handles the heatmapUATData query, mapping GraphQL types to domain types
 * and orchestrating the use-case.
 */

import { Frequency } from '@/common/types/temporal.js';

import { getHeatmapData } from '../../core/usecases/get-heatmap-data.js';

import type { UATAnalyticsRepository } from '../../core/ports.js';
import type {
  HeatmapCurrency,
  HeatmapTransformationOptions,
  NormalizedHeatmapDataPoint,
} from '../../core/types.js';
import type {
  AnalyticsFilter,
  GqlReportPeriodInput,
  PeriodType,
} from '@/common/types/analytics.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { IResolvers } from 'mercurius';

// ============================================================================
// Types
// ============================================================================

/**
 * Dependencies for UAT analytics resolvers.
 */
export interface MakeUATAnalyticsResolversDeps {
  repo: UATAnalyticsRepository;
  normalizationService: NormalizationService;
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
 * GraphQL output type for heatmap data point (uat_id is string for GraphQL ID).
 */
interface GqlHeatmapUATDataPoint extends Omit<NormalizedHeatmapDataPoint, 'uat_id'> {
  uat_id: string;
}

/**
 * GraphQL query arguments for heatmapUATData.
 */
interface HeatmapUATDataArgs {
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
 * Maps GraphQL arguments to HeatmapTransformationOptions.
 *
 * Handles legacy modes (total_euro, per_capita_euro) for backwards compatibility.
 * Also checks filter object for normalization params (backwards compatibility with clients
 * that send normalization inside filter).
 */
const toTransformationOptions = (args: HeatmapUATDataArgs): HeatmapTransformationOptions => {
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
const toGqlDataPoint = (point: NormalizedHeatmapDataPoint): GqlHeatmapUATDataPoint => ({
  ...point,
  uat_id: String(point.uat_id),
});

// ============================================================================
// Resolver Factory
// ============================================================================

/**
 * Creates UAT analytics resolvers.
 */
export const makeUATAnalyticsResolvers = (deps: MakeUATAnalyticsResolversDeps): IResolvers => {
  const { repo, normalizationService } = deps;

  return {
    Query: {
      heatmapUATData: async (
        _: unknown,
        args: HeatmapUATDataArgs
      ): Promise<GqlHeatmapUATDataPoint[]> => {
        // Convert GraphQL input to domain types
        const filter = toAnalyticsFilter(args.filter);
        const options = toTransformationOptions(args);

        // Execute use-case
        const result = await getHeatmapData({ repo, normalizationService }, { filter, options });

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
              throw new Error('An error occurred while fetching heatmap data');
            default:
              throw new Error('An unexpected error occurred');
          }
        }

        // Convert to GraphQL output types
        return result.value.map(toGqlDataPoint);
      },
    },
  };
};
