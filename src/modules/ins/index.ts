/**
 * INS Module - Public API
 */

// =============================================================================
// Repository
// =============================================================================
export { makeInsRepo } from './shell/repo/ins-repo.js';
export type { InsRepository } from './core/ports.js';

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

// =============================================================================
// GraphQL
// =============================================================================
export { InsSchema } from './shell/graphql/schema.js';
export { makeInsResolvers, type MakeInsResolversDeps } from './shell/graphql/resolvers.js';

// =============================================================================
// Types
// =============================================================================
export type {
  InsDataset,
  InsDatasetFilter,
  InsDatasetConnection,
  InsDatasetPageInfo,
  InsDimension,
  InsDimensionValue,
  InsDimensionValueConnection,
  InsDimensionValueFilter,
  InsObservation,
  InsObservationFilter,
  InsObservationConnection,
  InsObservationPageInfo,
  InsTerritory,
  InsTimePeriod,
  InsUnit,
  InsClassificationType,
  InsClassificationValue,
  InsUatIndicatorsInput,
  InsUatDashboardInput,
  InsUatDatasetGroup,
  InsCompareInput,
  ListInsObservationsInput,
} from './core/types.js';
export {
  DEFAULT_DATASET_LIMIT,
  DEFAULT_OBSERVATION_LIMIT,
  DEFAULT_DIMENSION_VALUES_LIMIT,
  MAX_DATASET_LIMIT,
  MAX_OBSERVATION_LIMIT,
  MAX_DIMENSION_VALUES_LIMIT,
  MAX_UAT_DASHBOARD_LIMIT,
} from './core/types.js';

// =============================================================================
// Errors
// =============================================================================
export type { InsError } from './core/errors.js';
export { createDatabaseError } from './core/errors.js';
