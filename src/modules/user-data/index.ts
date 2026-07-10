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
