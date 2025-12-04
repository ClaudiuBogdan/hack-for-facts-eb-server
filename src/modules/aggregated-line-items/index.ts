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
export type { AggregatedLineItemsRepository, PopulationRepository } from './core/ports.js';

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
export { makePopulationRepo } from './shell/repo/population-repo.js';
