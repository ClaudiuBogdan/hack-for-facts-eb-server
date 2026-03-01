/**
 * Experimental Map Module - Public API
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
  MapRequestSeries,
  GroupedSeriesDataRequest,
  ExperimentalMapWarning,
  MapSeriesVector,
  MapSeriesProviderOutput,
  GroupedSeriesManifestEntry,
  GroupedSeriesManifest,
  GroupedSeriesMatrixRow,
  GroupedSeriesMatrixData,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Errors
// ─────────────────────────────────────────────────────────────────────────────

export type {
  UnauthorizedError,
  ForbiddenError,
  InvalidInputError,
  ProviderError,
  ExperimentalMapError,
} from './core/errors.js';

export {
  createUnauthorizedError,
  createForbiddenError,
  createInvalidInputError,
  createProviderError,
  EXPERIMENTAL_MAP_ERROR_HTTP_STATUS,
  getHttpStatusForError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Ports
// ─────────────────────────────────────────────────────────────────────────────

export type { MapSeriesProvider } from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export {
  getGroupedSeriesData,
  type GetGroupedSeriesDataDeps,
  type GetGroupedSeriesDataInput,
} from './core/usecases/get-grouped-series-data.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Providers
// ─────────────────────────────────────────────────────────────────────────────

export { makeMockMapSeriesProvider } from './shell/providers/mock-map-series-provider.js';
export {
  makeDbMapSeriesProvider,
  type MakeDbMapSeriesProviderDeps,
} from './shell/providers/db-map-series-provider.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeExperimentalMapRoutes,
  type MakeExperimentalMapRoutesDeps,
} from './shell/rest/routes.js';

export {
  GroupedSeriesDataBodySchema,
  GroupedSeriesDataResponseSchema,
  ErrorResponseSchema,
  type GroupedSeriesDataBody,
} from './shell/rest/schemas.js';

export { serializeWideMatrixCsv } from './shell/rest/wide-csv.js';
