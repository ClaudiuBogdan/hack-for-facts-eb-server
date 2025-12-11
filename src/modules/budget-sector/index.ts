/**
 * Budget Sector Module - Public API
 *
 * Exposes budget sector reference data via GraphQL.
 * Supports lookup by ID and paginated search/filter listing.
 */

// =============================================================================
// Repository
// =============================================================================
export { makeBudgetSectorRepo } from './shell/repo/budget-sector-repo.js';
export type { BudgetSectorRepository } from './core/ports.js';

// =============================================================================
// Use Cases
// =============================================================================
export { getBudgetSector, type GetBudgetSectorDeps } from './core/usecases/get-budget-sector.js';
export {
  listBudgetSectors,
  type ListBudgetSectorsDeps,
} from './core/usecases/list-budget-sectors.js';

// =============================================================================
// GraphQL
// =============================================================================
export { BudgetSectorSchema } from './shell/graphql/schema.js';
export {
  makeBudgetSectorResolvers,
  type MakeBudgetSectorResolversDeps,
} from './shell/graphql/resolvers.js';

// =============================================================================
// Types
// =============================================================================
export type {
  BudgetSector,
  BudgetSectorPageInfo,
  BudgetSectorConnection,
  BudgetSectorFilter,
  ListBudgetSectorsInput,
} from './core/types.js';
export { DEFAULT_LIMIT, MAX_LIMIT, SIMILARITY_THRESHOLD } from './core/types.js';

// =============================================================================
// Errors
// =============================================================================
export type { BudgetSectorError } from './core/errors.js';
