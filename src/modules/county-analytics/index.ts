/**
 * County Analytics Module Public API
 *
 * Provides county-level heatmap analytics for budget execution data.
 * Aggregates UAT-level data to county level with normalization support.
 */

// ============================================================================
// Core Types
// ============================================================================

export type {
  HeatmapCountyDataPoint,
  NormalizedCountyHeatmapDataPoint,
  CountyHeatmapTransformationOptions,
  HeatmapCurrency,
  HeatmapNormalizationMode,
} from './core/types.js';

// ============================================================================
// Errors
// ============================================================================

export type { CountyAnalyticsError } from './core/errors.js';

export {
  createMissingRequiredFilterError,
  createInvalidPeriodError,
  createDatabaseError,
  createNormalizationError,
} from './core/errors.js';

// ============================================================================
// Ports
// ============================================================================

export type { CountyAnalyticsRepository } from './core/ports.js';

// ============================================================================
// Use Cases
// ============================================================================

export {
  getCountyHeatmapData,
  type GetCountyHeatmapDataDeps,
  type GetCountyHeatmapDataInput,
} from './core/usecases/get-county-heatmap-data.js';

// ============================================================================
// Repositories
// ============================================================================

export { makeCountyAnalyticsRepo } from './shell/repo/county-analytics-repo.js';

// ============================================================================
// GraphQL
// ============================================================================

export { CountyAnalyticsSchema } from './shell/graphql/schema.js';

export {
  makeCountyAnalyticsResolvers,
  type MakeCountyAnalyticsResolversDeps,
} from './shell/graphql/resolvers.js';
