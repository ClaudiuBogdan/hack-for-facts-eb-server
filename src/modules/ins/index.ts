/**
 * INS Module - Public API
 */

// =============================================================================
// Repository
// =============================================================================
export { makeInsRepo } from './shell/repo/ins-repo.js';
export { makeInsDatasetRequestRepo } from './shell/repo/ins-dataset-request-repo.js';
export type { InsRepository, InsDatasetRequestRepository } from './core/ports.js';

// =============================================================================
// REST
// =============================================================================
export { makeInsRoutes, type MakeInsRoutesDeps } from './shell/rest/routes.js';

// =============================================================================
// Use Cases
// =============================================================================
export { getInsDataset } from './core/usecases/get-ins-dataset.js';
export { listInsDatasets } from './core/usecases/list-ins-datasets.js';
export { listInsObservations } from './core/usecases/list-ins-observations.js';
export { getInsUatIndicators } from './core/usecases/get-ins-uat-indicators.js';
export { compareInsUats } from './core/usecases/compare-ins-uat.js';
export { getInsUatDashboard } from './core/usecases/get-ins-uat-dashboard.js';
export { listInsDimensionValues } from './core/usecases/list-ins-dimension-values.js';
export { listInsDatasetDimensionValues } from './core/usecases/list-ins-dataset-dimension-values.js';
export { listInsContexts } from './core/usecases/list-ins-contexts.js';
export { listInsTerritories } from './core/usecases/list-ins-territories.js';
export { createInsDatasetRequest } from './core/usecases/create-ins-dataset-request.js';
export { listInsLatestDatasetValues } from './core/usecases/list-ins-latest-dataset-values.js';

// =============================================================================
// GraphQL
// =============================================================================
export { InsSchema } from './shell/graphql/schema.js';
export { makeInsResolvers, type MakeInsResolversDeps } from './shell/graphql/resolvers.js';

// =============================================================================
// Types
// =============================================================================
export type {
  InsDataStatus,
  InsDataset,
  InsDatasetFilter,
  InsDatasetConnection,
  InsDatasetPageInfo,
  InsContext,
  InsContextFilter,
  InsContextConnection,
  InsContextPageInfo,
  InsDimension,
  InsDimensionValue,
  InsDimensionValueConnection,
  InsDimensionValueFilter,
  InsObservation,
  InsObservationFilter,
  InsObservationConnection,
  InsObservationPageInfo,
  InsTerritory,
  InsTerritoryConnection,
  InsTerritoryFilter,
  InsTerritoryPageInfo,
  InsTimePeriod,
  InsUnit,
  InsClassificationType,
  InsClassificationValue,
  InsUatIndicatorsInput,
  InsUatDashboardInput,
  InsUatDatasetGroup,
  InsCompareInput,
  InsLatestDatasetValue,
  InsLatestMatchStrategy,
  InsEntitySelectorInput,
  ListInsLatestDatasetValuesInput,
  ListInsObservationsInput,
} from './core/types.js';
export {
  DEFAULT_DATASET_LIMIT,
  DEFAULT_OBSERVATION_LIMIT,
  DEFAULT_DIMENSION_VALUES_LIMIT,
  MAX_DATASET_LIMIT,
  MAX_OBSERVATION_LIMIT,
  MAX_DIMENSION_VALUES_LIMIT,
  MAX_TERRITORY_LIMIT,
  MAX_UAT_DASHBOARD_LIMIT,
  DEFAULT_TERRITORY_LIMIT,
} from './core/types.js';

// =============================================================================
// Errors
// =============================================================================
export type { InsError } from './core/errors.js';
export { createDatabaseError } from './core/errors.js';

// =============================================================================
// Dataset Requests
// =============================================================================
export type { InsDatasetRequest, InsDatasetRequestInput } from './core/dataset-requests.js';
export { MAX_DATASET_REQUEST_NOTE_LENGTH } from './core/dataset-requests.js';
