/**
 * Execution Line Items Module - Public API
 *
 * Exposes individual budget execution line items via GraphQL.
 * Supports lookup by ID and paginated list with comprehensive filtering.
 *
 * Features:
 * - Single item lookup: executionLineItem(id)
 * - Paginated list: executionLineItems(filter, sort, limit, offset)
 * - Nested resolvers with DataLoaders for N+1 prevention
 */

// =============================================================================
// Repository
// =============================================================================
export { makeExecutionLineItemRepo } from './shell/repo/execution-line-items-repo.js';
export type { ExecutionLineItemRepository } from './core/ports.js';

// =============================================================================
// Use Cases
// =============================================================================
export {
  getExecutionLineItem,
  type GetExecutionLineItemDeps,
} from './core/usecases/get-execution-line-item.js';
export {
  listExecutionLineItems,
  type ListExecutionLineItemsDeps,
} from './core/usecases/list-execution-line-items.js';

// =============================================================================
// GraphQL
// =============================================================================
export { ExecutionLineItemSchema } from './shell/graphql/schema.js';
export {
  makeExecutionLineItemResolvers,
  type MakeExecutionLineItemResolversDeps,
} from './shell/graphql/resolvers.js';

// =============================================================================
// Mercurius Loaders
// =============================================================================
export { createExecutionLineItemLoaders } from './shell/graphql/loaders.js';

// =============================================================================
// Types
// =============================================================================
export type {
  ExecutionLineItem,
  ExecutionLineItemOutput,
  ExecutionLineItemPageInfo,
  ExecutionLineItemConnection,
  ExecutionLineItemFilter,
  ListExecutionLineItemsInput,
  SortInput,
  SortOrder,
  SortableField,
} from './core/types.js';
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  QUERY_TIMEOUT_MS,
  SORTABLE_FIELDS,
  DEFAULT_SORT,
  DEFAULT_SECONDARY_SORT,
} from './core/types.js';

// =============================================================================
// Errors
// =============================================================================
export type { ExecutionLineItemError, MissingRequiredFieldError } from './core/errors.js';
export {
  createDatabaseError,
  createTimeoutError,
  createMissingRequiredFieldError,
} from './core/errors.js';
