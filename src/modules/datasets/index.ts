// Repository
export { createDatasetRepo, type DatasetRepoOptions } from './shell/repo/fs-repo.js';
export type { DatasetRepo } from './core/ports.js';

// Use cases
export { parseDataset } from './core/usecases/parse-dataset.js';
export { listDatasets } from './core/usecases/list-datasets.js';
export { getStaticChartAnalytics } from './core/usecases/get-static-chart-analytics.js';
export { localizeDataset, toDatasetSummary } from './core/usecases/localize-dataset.js';
export { mapAxisType, mapFrequencyToGranularity } from './core/usecases/map-axis-type.js';

// GraphQL
export { DatasetsSchema } from './shell/graphql/schema.js';
export {
  makeDatasetsResolvers,
  type MakeDatasetsResolversDeps,
} from './shell/graphql/resolvers.js';

// Types
export type {
  Dataset,
  DatasetFileDTO,
  DataPoint,
  DatasetFileEntry,
  // GraphQL-oriented types
  AxisDataType,
  AxisGranularity,
  GraphQLAxis,
  DatasetSummary,
  DatasetPageInfo,
  DatasetConnection,
  DatasetFilter,
  ListDatasetsInput,
  AnalyticsDataPoint,
  AnalyticsSeries,
  GetStaticChartAnalyticsInput,
} from './core/types.js';

// Errors
export type { DatasetValidationError, DatasetRepoError } from './core/errors.js';
