// Ports
export type {
  NormalizationDatasetProvider,
  DatasetProviderError,
  NormalizationPort,
  PopulationRepository,
  PopulationError,
} from './core/ports.js';

// Types
export type {
  Currency,
  NormalizationMode,
  NormalizableDataPoint,
  TransformationOptions,
  NormalizationFactors,
  DataPoint,
} from './core/types.js';
export { toLegacyDataPoint, fromLegacyDataPoint } from './core/types.js';

// Dataset Registry
export type {
  NormalizationDimension,
  DatasetFrequency,
  DimensionDatasets,
  NormalizationDatasetRegistry,
} from './core/dataset-registry.js';
export {
  NORMALIZATION_DATASETS,
  getRequiredDatasetIds,
  getDimensionDatasetIds,
  getAllDatasetIds,
  getBestAvailableDatasetId,
  hasHigherFrequencyData,
  frequencyToDatasetFrequency,
} from './core/dataset-registry.js';

// Factor Maps
export type { FactorMap, FactorDatasets } from './core/factor-maps.js';
export {
  generateFactorMap,
  datasetToFactorMap,
  createFactorDatasets,
  getFactorOrDefault,
} from './core/factor-maps.js';

// Logic
export {
  applyInflation,
  applyCurrency,
  applyPerCapita,
  applyPercentGDP,
  applyGrowth,
  normalizeData,
} from './core/logic.js';

// Service
export {
  NormalizationService,
  NormalizationDatasetError,
} from './shell/service/normalization-service.js';

// Population
export { getDenominatorPopulation } from './core/population.js';
export { makePopulationRepo } from './shell/repo/population-repo.js';
