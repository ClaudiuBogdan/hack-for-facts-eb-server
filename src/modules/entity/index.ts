/**
 * Entity Module Public API
 *
 * Exports types, use cases, repositories, and GraphQL components.
 *
 * Note: UAT and Report types/use cases have been moved to their own modules.
 * Re-exports are provided here for backward compatibility.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  Entity,
  EntityFilter,
  EntityConnection,
  EntityPageInfo,
  EntityTotals,
  ReportPeriodInput,
  NormalizationMode,
  AnalyticsSeries,
  DataSeries,
} from './core/types.js';

export { DEFAULT_LIMIT, MAX_LIMIT, SIMILARITY_THRESHOLD } from './core/types.js';

// Re-export Report types for backward compatibility (moved to report module)
export type { DbReportType, GqlReportType } from './core/types.js';
export { GQL_TO_DB_REPORT_TYPE, DB_TO_GQL_REPORT_TYPE } from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type { EntityError } from './core/errors.js';

export {
  createDatabaseError,
  createTimeoutError,
  createEntityNotFoundError,
  createInvalidFilterError,
  createInvalidPeriodError,
  isTimeoutError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

export type { EntityRepository, EntityAnalyticsSummaryRepository } from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export { getEntity, type GetEntityDeps, type GetEntityInput } from './core/usecases/get-entity.js';

export {
  listEntities,
  type ListEntitiesDeps,
  type ListEntitiesInput,
} from './core/usecases/list-entities.js';

// ─────────────────────────────────────────────────────────────────────────────
// Repositories
// ─────────────────────────────────────────────────────────────────────────────

export { makeEntityRepo } from './shell/repo/entity-repo.js';
export { makeEntityAnalyticsSummaryRepo } from './shell/repo/entity-analytics-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

export { EntitySchema } from './shell/graphql/schema.js';
export { makeEntityResolvers, type MakeEntityResolversDeps } from './shell/graphql/resolvers.js';
export { createEntityLoaders } from './shell/graphql/loaders.js';
