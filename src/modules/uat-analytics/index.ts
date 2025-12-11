/**
 * UAT Analytics Module Public API
 *
 * Exports types, use cases, repositories, and GraphQL components
 * for UAT heatmap analytics.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  HeatmapUATDataPoint,
  NormalizedHeatmapDataPoint,
  HeatmapNormalizationMode,
  HeatmapCurrency,
  HeatmapTransformationOptions,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type { UATAnalyticsError } from './core/errors.js';

export {
  createMissingRequiredFilterError,
  createInvalidPeriodError,
  createDatabaseError,
  createNormalizationError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

export type { UATAnalyticsRepository } from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export {
  getHeatmapData,
  type GetHeatmapDataDeps,
  type GetHeatmapDataInput,
} from './core/usecases/get-heatmap-data.js';

// ─────────────────────────────────────────────────────────────────────────────
// Repositories
// ─────────────────────────────────────────────────────────────────────────────

export { makeUATAnalyticsRepo } from './shell/repo/uat-analytics-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

export { UATAnalyticsSchema } from './shell/graphql/schema.js';
export {
  makeUATAnalyticsResolvers,
  type MakeUATAnalyticsResolversDeps,
} from './shell/graphql/resolvers.js';
