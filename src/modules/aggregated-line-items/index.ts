// =============================================================================
// Public API for aggregated-line-items module
// =============================================================================

// Types
export type {
  AggregatedLineItem,
  AggregatedLineItemConnection,
  AggregatedLineItemsInput,
  ClassificationPeriodData,
  ClassificationPeriodResult,
  PageInfo,
  GqlAggregatedLineItemsInput,
  GqlAnalyticsFilterInput,
} from './core/types.js';

// Errors
export type { AggregatedLineItemsError, NormalizationDataError } from './core/errors.js';

// Ports
export type { AggregatedLineItemsRepository } from './core/ports.js';
// Re-export PopulationRepository from normalization module for backward compatibility
export type { PopulationRepository } from '@/modules/normalization/index.js';

// Use case
export {
  getAggregatedLineItems,
  getAggregatedLineItemsSqlNormalized,
  getAggregatedLineItemsInMemory,
  type GetAggregatedLineItemsDeps,
  type NormalizationFactorProvider,
} from './core/usecases/get-aggregated-line-items.js';

// GraphQL
export { AggregatedLineItemsSchema } from './shell/graphql/schema.js';
export {
  makeAggregatedLineItemsResolvers,
  type MakeAggregatedLineItemsResolversDeps,
} from './shell/graphql/resolvers.js';

// Repository
export { makeAggregatedLineItemsRepo } from './shell/repo/aggregated-line-items-repo.js';
// Re-export makePopulationRepo from normalization module for backward compatibility
export { makePopulationRepo } from '@/modules/normalization/index.js';
