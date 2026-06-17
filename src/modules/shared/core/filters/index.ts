/**
 * Shared Kernel — Filter pipeline public surface (foundation §7, §14.2).
 *
 * One `CollectionFilterSpec` → TypeBox (REST) + GraphQL input (SDL) +
 * parameterized SQL conditions + a stable canonical hash that backs the cache
 * key, cursor `fhash`, and tri-surface equivalence. Per-source plans declare
 * specs; they never invent a DSL.
 */

export * from './types.js';
export * from './composer.js';
export * from './derive.js';
export * from './surfaces.js';
export * from './territory.js';
