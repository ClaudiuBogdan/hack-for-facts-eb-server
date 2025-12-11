/**
 * UAT Module Public API
 *
 * Exports types, use cases, repositories, and GraphQL components.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { UAT, UATFilter, UATConnection, UATPageInfo } from './core/types.js';

export { DEFAULT_UAT_LIMIT, MAX_UAT_LIMIT, UAT_SIMILARITY_THRESHOLD } from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type { UATError } from './core/errors.js';

export {
  createDatabaseError,
  createTimeoutError,
  createUATNotFoundError,
  createInvalidFilterError,
  isTimeoutError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

export type { UATRepository } from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export { getUAT, type GetUATDeps, type GetUATInput } from './core/usecases/get-uat.js';

export { listUATs, type ListUATsDeps, type ListUATsInput } from './core/usecases/list-uats.js';

// ─────────────────────────────────────────────────────────────────────────────
// Repositories
// ─────────────────────────────────────────────────────────────────────────────

export { makeUATRepo } from './shell/repo/uat-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

export { UATSchema } from './shell/graphql/schema.js';
export { makeUATResolvers, type MakeUATResolversDeps } from './shell/graphql/resolvers.js';
export { createUATLoaders } from './shell/graphql/loaders.js';
