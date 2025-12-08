/**
 * Cache key generation with namespaces for targeted invalidation.
 */

import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const CacheNamespace = {
  // ─────────────────────────────────────────────────────────────────────────
  // Analytics (expensive aggregation queries)
  // ─────────────────────────────────────────────────────────────────────────
  /** Execution analytics time series */
  ANALYTICS_EXECUTION: 'analytics:execution',
  /** Aggregated line items by classification */
  ANALYTICS_AGGREGATED: 'analytics:aggregated',
  /** County-level heatmap data */
  ANALYTICS_COUNTY: 'analytics:county',
  /** Entity-level analytics */
  ANALYTICS_ENTITY: 'analytics:entity',
  /** UAT-level analytics heatmap */
  ANALYTICS_UAT: 'analytics:uat',

  // ─────────────────────────────────────────────────────────────────────────
  // Line items (detailed row-level queries)
  // ─────────────────────────────────────────────────────────────────────────
  /** Execution line items (Entity.executionLineItems) */
  EXECUTION_LINE_ITEMS: 'line-items:execution',

  // ─────────────────────────────────────────────────────────────────────────
  // Reference data (static/rarely changing)
  // ─────────────────────────────────────────────────────────────────────────
  /** Budget sectors lookup */
  REF_BUDGET_SECTORS: 'ref:budget-sectors',
  /** Funding sources lookup */
  REF_FUNDING_SOURCES: 'ref:funding-sources',
  /** Classification codes (functional & economic) */
  REF_CLASSIFICATION: 'ref:classification',

  // ─────────────────────────────────────────────────────────────────────────
  // Normalization data
  // ─────────────────────────────────────────────────────────────────────────
  /** Population data for per-capita calculations */
  NORMALIZATION_POPULATION: 'norm:population',

  // ─────────────────────────────────────────────────────────────────────────
  // Other
  // ─────────────────────────────────────────────────────────────────────────
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
 * Recursively sorts all keys in an object for deterministic serialization.
 * Handles nested objects and arrays.
 */
const sortObjectKeys = (obj: unknown): unknown => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return result;
};

/**
 * Hash a filter object to create a deterministic cache key identifier.
 * Uses SHA-256, truncated to 16 characters.
 *
 * Note: Recursively sorts all keys (including nested objects) to ensure
 * deterministic serialization regardless of property insertion order.
 */
const hashFilter = (filter: Record<string, unknown>): string => {
  // Recursively sort all keys for deterministic serialization
  const sorted = sortObjectKeys(filter);
  const normalized = JSON.stringify(sorted);
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
