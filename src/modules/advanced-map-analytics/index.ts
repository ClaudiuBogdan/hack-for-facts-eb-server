/**
 * Advanced Map Analytics Module - Public API
 */

// Core types
export type {
  AdvancedMapAnalyticsVisibility,
  AdvancedMapAnalyticsSnapshotDocument,
  AdvancedMapAnalyticsMap,
  AdvancedMapAnalyticsSnapshotSummary,
  AdvancedMapAnalyticsSnapshotDetail,
  AdvancedMapAnalyticsPublicView,
  CreateAdvancedMapAnalyticsMapInput,
  UpdateAdvancedMapAnalyticsMapInput,
  SaveAdvancedMapAnalyticsSnapshotInput,
} from './core/types.js';

export {
  ADVANCED_MAP_ANALYTICS_SNAPSHOT_CAP,
  ADVANCED_MAP_ANALYTICS_TITLE_MAX_LENGTH,
  ADVANCED_MAP_ANALYTICS_DESCRIPTION_MAX_LENGTH,
} from './core/types.js';

// Core errors
export type {
  UnauthorizedError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  SnapshotLimitReachedError,
  ProviderError,
  AdvancedMapAnalyticsError,
} from './core/errors.js';

export {
  createUnauthorizedError,
  createForbiddenError,
  createInvalidInputError,
  createNotFoundError,
  createSnapshotLimitReachedError,
  createProviderError,
  ADVANCED_MAP_ANALYTICS_ERROR_HTTP_STATUS,
  getHttpStatusForError,
} from './core/errors.js';

// Core ports
export type {
  AdvancedMapAnalyticsRepository,
  CreateMapParams,
  UpdateMapParams,
  AppendSnapshotParams,
} from './core/ports.js';

// Core use-cases
export { createMap, type CreateMapDeps, type CreateMapInput } from './core/usecases/create-map.js';
export { listMaps, type ListMapsDeps, type ListMapsInput } from './core/usecases/list-maps.js';
export { getMap, type GetMapDeps, type GetMapInput } from './core/usecases/get-map.js';
export { updateMap, type UpdateMapDeps, type UpdateMapInput } from './core/usecases/update-map.js';
export {
  saveMapSnapshot,
  type SaveMapSnapshotDeps,
  type SaveMapSnapshotInput,
} from './core/usecases/save-map-snapshot.js';
export {
  listMapSnapshots,
  type ListMapSnapshotsDeps,
  type ListMapSnapshotsInput,
} from './core/usecases/list-map-snapshots.js';
export {
  getMapSnapshot,
  type GetMapSnapshotDeps,
  type GetMapSnapshotInput,
} from './core/usecases/get-map-snapshot.js';
export {
  getPublicMap,
  type GetPublicMapDeps,
  type GetPublicMapInput,
} from './core/usecases/get-public-map.js';

// Shell repo
export {
  makeAdvancedMapAnalyticsRepo,
  type AdvancedMapAnalyticsRepoOptions,
} from './shell/repo/advanced-map-analytics-repo.js';

// Shell route
export {
  makeAdvancedMapAnalyticsRoutes,
  type MakeAdvancedMapAnalyticsRoutesDeps,
} from './shell/rest/routes.js';

// Shell schemas
export {
  VisibilitySchema,
  MapIdParamsSchema,
  SnapshotParamsSchema,
  PublicMapParamsSchema,
  CreateMapBodySchema,
  UpdateMapBodySchema,
  SaveSnapshotBodySchema,
  MapResponseSchema,
  MapListResponseSchema,
  SnapshotListResponseSchema,
  SnapshotResponseSchema,
  SaveSnapshotResponseSchema,
  PublicMapResponseSchema,
  ErrorResponseSchema,
  type MapIdParams,
  type SnapshotParams,
  type PublicMapParams,
  type CreateMapBody,
  type UpdateMapBody,
  type SaveSnapshotBody,
} from './shell/rest/schemas.js';

// Shell utils
export {
  defaultAdvancedMapAnalyticsIdGenerator,
  type AdvancedMapAnalyticsIdGenerator,
} from './shell/utils/id-generator.js';

// Grouped-series subdomain (map data extraction)
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
  GroupedSeriesWarning,
  MapSeriesVector,
  GroupedSeriesProviderOutput,
  GroupedSeriesManifestEntry,
  GroupedSeriesManifest,
  GroupedSeriesMatrixRow,
  GroupedSeriesMatrixData,
} from './grouped-series/core/types.js';

export type {
  UnauthorizedError as GroupedSeriesUnauthorizedError,
  ForbiddenError as GroupedSeriesForbiddenError,
  InvalidInputError as GroupedSeriesInvalidInputError,
  ProviderError as GroupedSeriesProviderError,
  GroupedSeriesError,
} from './grouped-series/core/errors.js';

export {
  createUnauthorizedError as createGroupedSeriesUnauthorizedError,
  createForbiddenError as createGroupedSeriesForbiddenError,
  createInvalidInputError as createGroupedSeriesInvalidInputError,
  createProviderError as createGroupedSeriesProviderError,
  GROUPED_SERIES_ERROR_HTTP_STATUS,
  getHttpStatusForError as getGroupedSeriesHttpStatusForError,
} from './grouped-series/core/errors.js';

export type { GroupedSeriesProvider } from './grouped-series/core/ports.js';

export {
  getGroupedSeriesData,
  type GetGroupedSeriesDataDeps,
  type GetGroupedSeriesDataInput,
} from './grouped-series/core/usecases/get-grouped-series-data.js';

export {
  makeMockAdvancedMapAnalyticsGroupedSeriesProvider,
  makeDbAdvancedMapAnalyticsGroupedSeriesProvider,
  type MakeDbAdvancedMapAnalyticsGroupedSeriesProviderDeps,
} from './grouped-series/index.js';

export {
  makeAdvancedMapAnalyticsGroupedSeriesRoutes,
  type MakeAdvancedMapAnalyticsGroupedSeriesRoutesDeps,
  GroupedSeriesDataBodySchema,
  GroupedSeriesDataResponseSchema,
  ErrorResponseSchema as GroupedSeriesErrorResponseSchema,
  type GroupedSeriesDataBody,
  serializeWideMatrixCsv,
} from './grouped-series/index.js';
