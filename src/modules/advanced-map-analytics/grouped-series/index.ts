/**
 * Advanced Map Analytics Module - Public API
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  MapGranularity,
  MapSeriesNormalizationMode,
  ExecutionMapSeriesFilter,
  CommitmentsMapSeriesFilter,
  ExecutionMapSeries,
  CommitmentsMapSeries,
  InsMapSeries,
  UploadedMapDatasetSeries,
  MapRequestSeries,
  GroupedSeriesDataRequest,
  GroupedSeriesWarning,
  MapSeriesVector,
  GroupedSeriesProviderOutput,
  GroupedSeriesManifestEntry,
  GroupedSeriesManifest,
  GroupedSeriesMatrixRow,
  GroupedSeriesMatrixData,
} from './core/types.js';

export { GROUPED_SERIES_RESERVED_ID_PREFIXES } from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Errors
// ─────────────────────────────────────────────────────────────────────────────

export type {
  InvalidInputError,
  NotFoundError,
  ProviderError,
  GroupedSeriesError,
} from './core/errors.js';

export {
  createInvalidInputError,
  createNotFoundError,
  createProviderError,
  GROUPED_SERIES_ERROR_HTTP_STATUS,
  getHttpStatusForError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Ports
// ─────────────────────────────────────────────────────────────────────────────

export type { GroupedSeriesProvider } from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export {
  getGroupedSeriesData,
  validateGroupedSeriesRequestSeries,
  type GetGroupedSeriesDataDeps,
  type GetGroupedSeriesDataInput,
} from './core/usecases/get-grouped-series-data.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Providers
// ─────────────────────────────────────────────────────────────────────────────

export { makeMockAdvancedMapAnalyticsGroupedSeriesProvider } from './shell/providers/mock-map-series-provider.js';
export {
  makeDbAdvancedMapAnalyticsGroupedSeriesProvider,
  type MakeDbAdvancedMapAnalyticsGroupedSeriesProviderDeps,
} from './shell/providers/db-map-series-provider.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeAdvancedMapAnalyticsGroupedSeriesRoutes,
  type MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps,
} from './shell/rest/routes.js';

export {
  GroupedSeriesDataBodySchema,
  GroupedSeriesDataSchema,
  GroupedSeriesDataResponseSchema,
  ErrorResponseSchema,
  type GroupedSeriesDataBody,
  type GroupedSeriesData,
} from './shell/rest/schemas.js';

export { serializeWideMatrixCsv } from './shell/rest/wide-csv.js';
