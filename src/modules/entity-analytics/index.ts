// =============================================================================
// Public API for entity-analytics module
// =============================================================================

// Types
export type {
  EntityAnalyticsDataPoint,
  EntityAnalyticsConnection,
  EntityAnalyticsInput,
  EntityAnalyticsRow,
  EntityAnalyticsResult,
  EntityAnalyticsSort,
  EntityAnalyticsSortField,
  PageInfo,
  GqlEntityAnalyticsInput,
  GqlAnalyticsFilterInput,
  PeriodFactorMap,
  PaginationParams,
  AggregateFilters,
  SortDirection,
} from './core/types.js';

// Errors
export type { EntityAnalyticsError, NormalizationDataError } from './core/errors.js';

// Ports
export type { EntityAnalyticsRepository } from './core/ports.js';

// Use case
export {
  getEntityAnalytics,
  type GetEntityAnalyticsDeps,
  type NormalizationFactorProvider,
} from './core/usecases/get-entity-analytics.js';

// GraphQL
export { EntityAnalyticsSchema } from './shell/graphql/schema.js';
export {
  makeEntityAnalyticsResolvers,
  type MakeEntityAnalyticsResolversDeps,
} from './shell/graphql/resolvers.js';

// Repository
export { makeEntityAnalyticsRepo } from './shell/repo/entity-analytics-repo.js';
