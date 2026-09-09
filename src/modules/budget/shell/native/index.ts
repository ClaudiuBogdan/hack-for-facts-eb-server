/** The kernel-build (native) budget adapters: population through the kernel port, promoted factors. */
export {
  NATIVE_FACTOR_SET_DIGEST,
  NATIVE_FACTOR_SET_ID,
  makeNativeBudgetFactors,
} from './factors.js';
export { makeNativeBudgetRepo, type NativeBudgetRepoDeps } from './budget-repo.js';
export {
  makeNativeExecutionSeries,
  type NativeExecutionSeriesAdapterDeps,
} from './execution-series.js';
export { makeNativeGroupedEntities, type NativeGroupedAdapterDeps } from './grouped-entities.js';
export {
  makeNativeGroupedClassifications,
  type NativeGroupedClassificationsDeps,
} from './grouped-classifications.js';
export { makeNativeMapPopulation, readNativeMapPopulation } from './map-population.js';
export { readNativeAnnualScopePopulation } from './annual-scope-population.js';
export { populationRelation } from './population-relation.js';
export { preloadFactors } from './preloaded-factors.js';
