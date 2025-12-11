/**
 * Funding Source Module - Public API
 *
 * Exposes funding source reference data via GraphQL.
 * Supports lookup by ID, paginated search/filter listing, and nested execution line items.
 */

// =============================================================================
// Repository
// =============================================================================
export {
  makeFundingSourceRepo,
  makeExecutionLineItemRepo,
} from './shell/repo/funding-sources-repo.js';
export type { FundingSourceRepository, ExecutionLineItemRepository } from './core/ports.js';

// =============================================================================
// Use Cases
// =============================================================================
export { getFundingSource, type GetFundingSourceDeps } from './core/usecases/get-funding-source.js';
export {
  listFundingSources,
  type ListFundingSourcesDeps,
} from './core/usecases/list-funding-sources.js';

// =============================================================================
// GraphQL
// =============================================================================
export { FundingSourceSchema } from './shell/graphql/schema.js';
export {
  makeFundingSourceResolvers,
  type MakeFundingSourceResolversDeps,
} from './shell/graphql/resolvers.js';

// =============================================================================
// Types
// =============================================================================
export type {
  FundingSource,
  FundingSourcePageInfo,
  FundingSourceConnection,
  FundingSourceFilter,
  ListFundingSourcesInput,
  ExecutionLineItem,
  ExecutionLineItemPageInfo,
  ExecutionLineItemConnection,
  ExecutionLineItemFilter,
  ListExecutionLineItemsInput,
} from './core/types.js';
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SIMILARITY_THRESHOLD,
  DEFAULT_LINE_ITEMS_LIMIT,
  MAX_LINE_ITEMS_LIMIT,
} from './core/types.js';

// =============================================================================
// Errors
// =============================================================================
export type { FundingSourceError } from './core/errors.js';
