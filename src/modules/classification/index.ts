/**
 * Classification Module - Public API
 *
 * Exposes functional and economic classification queries via GraphQL.
 */

// =============================================================================
// Repository
// =============================================================================
export {
  makeFunctionalClassificationRepo,
  makeEconomicClassificationRepo,
} from './shell/repo/classification-repo.js';
export type {
  FunctionalClassificationRepository,
  EconomicClassificationRepository,
} from './core/ports.js';

// =============================================================================
// Use Cases
// =============================================================================
export {
  getFunctionalClassification,
  type GetFunctionalClassificationDeps,
} from './core/usecases/get-functional-classification.js';
export {
  listFunctionalClassifications,
  type ListFunctionalClassificationsDeps,
  type ListFunctionalClassificationsInput,
} from './core/usecases/list-functional-classifications.js';
export {
  getEconomicClassification,
  type GetEconomicClassificationDeps,
} from './core/usecases/get-economic-classification.js';
export {
  listEconomicClassifications,
  type ListEconomicClassificationsDeps,
  type ListEconomicClassificationsInput,
} from './core/usecases/list-economic-classifications.js';

// =============================================================================
// GraphQL
// =============================================================================
export { ClassificationSchema } from './shell/graphql/schema.js';
export {
  makeClassificationResolvers,
  type MakeClassificationResolversDeps,
} from './shell/graphql/resolvers.js';

// =============================================================================
// Types
// =============================================================================
export type {
  FunctionalClassification,
  FunctionalClassificationFilter,
  FunctionalClassificationConnection,
  EconomicClassification,
  EconomicClassificationFilter,
  EconomicClassificationConnection,
  PageInfo,
} from './core/types.js';
export { DEFAULT_LIMIT, MAX_LIMIT } from './core/types.js';

// =============================================================================
// Errors
// =============================================================================
export type { ClassificationError } from './core/errors.js';
export { createDatabaseError } from './core/errors.js';
