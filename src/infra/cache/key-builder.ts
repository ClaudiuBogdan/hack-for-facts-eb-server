/**
 * Cache key generation with namespaces for targeted invalidation.
 */

import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const CacheNamespace = {
  /** Execution analytics time series */
  ANALYTICS_EXECUTION: 'analytics:execution',
  /** Aggregated line items by classification */
  ANALYTICS_AGGREGATED: 'analytics:aggregated',
  /** County-level heatmap data */
  ANALYTICS_COUNTY: 'analytics:county',
  /** Entity-level analytics */
  ANALYTICS_ENTITY: 'analytics:entity',
  /** Dataset files */
  DATASETS: 'datasets',
} as const;

export type CacheNamespace = (typeof CacheNamespace)[keyof typeof CacheNamespace];

// ─────────────────────────────────────────────────────────────────────────────
// Key Builder Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyBuilder {
  /**
   * Build a cache key from namespace and identifier.
   * Format: `{globalPrefix}:{namespace}:{identifier}`
   */
  build(namespace: CacheNamespace, identifier: string): string;

  /**
   * Build a key from a filter object by hashing it.
   * Produces deterministic keys for identical filters.
   */
  fromFilter(namespace: CacheNamespace, filter: Record<string, unknown>): string;

  /**
   * Get the prefix for a namespace (for invalidation).
   * Format: `{globalPrefix}:{namespace}:`
   */
  getPrefix(namespace: CacheNamespace): string;

  /**
   * Get the global prefix used for all keys.
   */
  getGlobalPrefix(): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hash a filter object to create a deterministic cache key identifier.
 * Uses SHA-256, truncated to 16 characters.
 */
const hashFilter = (filter: Record<string, unknown>): string => {
  // Sort keys for deterministic serialization
  const sortedKeys = Object.keys(filter).sort();
  const normalized = JSON.stringify(filter, sortedKeys);
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
};

export interface KeyBuilderOptions {
  /** Global prefix for all keys. Defaults to 'transparenta'. */
  globalPrefix?: string;
}

/**
 * Create a key builder instance.
 */
export const createKeyBuilder = (options: KeyBuilderOptions = {}): KeyBuilder => {
  const globalPrefix = options.globalPrefix ?? 'transparenta';

  return {
    build(namespace: CacheNamespace, identifier: string): string {
      return `${globalPrefix}:${namespace}:${identifier}`;
    },

    fromFilter(namespace: CacheNamespace, filter: Record<string, unknown>): string {
      const hash = hashFilter(filter);
      return `${globalPrefix}:${namespace}:${hash}`;
    },

    getPrefix(namespace: CacheNamespace): string {
      return `${globalPrefix}:${namespace}:`;
    },

    getGlobalPrefix(): string {
      return globalPrefix;
    },
  };
};
