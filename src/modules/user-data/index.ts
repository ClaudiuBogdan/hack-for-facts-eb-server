export * from './core/errors.js';
export * from './core/ports.js';
export { makeCategoryRegistry, type CategoryRegistry } from './core/registry/registry.js';
export type {
  AnnotationNamespaceDefinition,
  CategoryDefinition,
  CategorySchemaVersion,
  QueryFieldDefinition,
  ResolvedCategory,
} from './core/registry/types.js';
export { ALL_USER_DATA_CATEGORIES } from './core/registry/categories/index.js';
export {
  decodeSyncCursor,
  encodeSyncCursor,
  validateSyncCursorCategory,
  type SyncCursor,
} from './core/sync-cursor.js';
export * from './core/types.js';
export { makeUserDataMutationRepo } from './shell/repo/kysely-user-data-mutation-repo.js';
export { makeUserDataReadRepo } from './shell/repo/kysely-user-data-read-repo.js';
export { makeUserDataAdminReadRepo } from './shell/repo/kysely-user-data-admin-read-repo.js';
export { makeUserDataErasureRepo } from './shell/repo/kysely-user-data-erasure-repo.js';
export { makeRedisMutationRateLimiter } from './shell/repo/redis-mutation-rate-limiter.js';
export {
  makeUserDataOwnerRoutes,
  type MakeUserDataOwnerRoutesDeps,
} from './shell/rest/owner-routes.js';
export {
  makeUserDataAdminRoutes,
  type MakeUserDataAdminRoutesDeps,
} from './shell/rest/admin-routes.js';
