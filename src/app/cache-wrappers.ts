/**
 * Cache wrapper factories for repository methods.
 *
 * This module provides type-safe cache wrappers for repository methods.
 * Each wrapper function creates a cached version of a repository interface.
 */

import { ok, type Result } from 'neverthrow';

import { CacheNamespace, type KeyBuilder, type SilentCachePort } from '../infra/cache/index.js';

import type { AnalyticsFilter as CommonAnalyticsFilter } from '../common/types/analytics.js';
import type { DataSeries } from '../common/types/temporal.js';
import type { AggregatedLineItemsError } from '../modules/aggregated-line-items/core/errors.js';
import type { AggregatedLineItemsRepository } from '../modules/aggregated-line-items/core/ports.js';
import type {
  ClassificationPeriodResult,
  NormalizedAggregatedResult,
  PeriodFactorMap as AggPeriodFactorMap,
  AggregateFilters as AggAggregateFilters,
  PaginationParams as AggPaginationParams,
} from '../modules/aggregated-line-items/core/types.js';
import type { BudgetSectorError } from '../modules/budget-sector/core/errors.js';
import type { BudgetSectorRepository } from '../modules/budget-sector/core/ports.js';
import type {
  BudgetSector,
  BudgetSectorFilter,
  BudgetSectorConnection,
} from '../modules/budget-sector/core/types.js';
import type { ClassificationError } from '../modules/classification/core/errors.js';
import type {
  FunctionalClassificationRepository,
  EconomicClassificationRepository,
} from '../modules/classification/core/ports.js';
import type {
  FunctionalClassification,
  FunctionalClassificationFilter,
  FunctionalClassificationConnection,
  EconomicClassification,
  EconomicClassificationFilter,
  EconomicClassificationConnection,
} from '../modules/classification/core/types.js';
import type { CountyAnalyticsError } from '../modules/county-analytics/core/errors.js';
import type { CountyAnalyticsRepository } from '../modules/county-analytics/core/ports.js';
import type { HeatmapCountyDataPoint } from '../modules/county-analytics/core/types.js';
import type { EntityAnalyticsError } from '../modules/entity-analytics/core/errors.js';
import type { EntityAnalyticsRepository } from '../modules/entity-analytics/core/ports.js';
import type {
  EntityAnalyticsResult,
  PeriodFactorMap,
  PaginationParams,
  AggregateFilters,
  EntityAnalyticsSort,
} from '../modules/entity-analytics/core/types.js';
import type { AnalyticsError } from '../modules/execution-analytics/core/errors.js';
import type { AnalyticsRepository } from '../modules/execution-analytics/core/ports.js';
import type { AnalyticsFilter } from '../modules/execution-analytics/core/types.js';
import type { ExecutionLineItemError } from '../modules/execution-line-items/core/errors.js';
import type { ExecutionLineItemRepository } from '../modules/execution-line-items/core/ports.js';
import type {
  ExecutionLineItemFilter,
  ExecutionLineItemConnection,
  SortInput,
} from '../modules/execution-line-items/core/types.js';
import type { FundingSourceError } from '../modules/funding-sources/core/errors.js';
import type {
  FundingSourceRepository,
  ExecutionLineItemRepository as FundingSourceLineItemRepository,
} from '../modules/funding-sources/core/ports.js';
import type {
  FundingSource,
  FundingSourceFilter,
  FundingSourceConnection,
  ExecutionLineItemFilter as FundingSourceLineItemFilter,
  ExecutionLineItemConnection as FundingSourceLineItemConnection,
} from '../modules/funding-sources/core/types.js';
import type { InsRepository } from '../modules/ins/core/ports.js';
import type {
  InsDatasetFilter,
  InsObservationFilter,
  ListInsLatestDatasetValuesInput,
  ListInsObservationsInput,
} from '../modules/ins/core/types.js';
import type { PopulationError, PopulationRepository } from '../modules/normalization/core/ports.js';
import type { UATAnalyticsError } from '../modules/uat-analytics/core/errors.js';
import type { UATAnalyticsRepository } from '../modules/uat-analytics/core/ports.js';
import type { HeatmapUATDataPoint } from '../modules/uat-analytics/core/types.js';
import type { Decimal } from 'decimal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper type for creating cache keys from filters
// ─────────────────────────────────────────────────────────────────────────────

type FilterLike = Record<string, unknown>;
const INS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const toSortedUniqueArray = <T extends string>(values: T[] | undefined): T[] | undefined => {
  if (values === undefined) {
    return undefined;
  }
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
};

const normalizeDatasetFilterForCache = (filter: InsDatasetFilter): InsDatasetFilter => {
  const normalizedCodes = toSortedUniqueArray(filter.codes);
  const normalizedPeriodicity = toSortedUniqueArray(filter.periodicity);
  const normalizedSyncStatus = toSortedUniqueArray(filter.sync_status);

  return {
    ...filter,
    ...(normalizedCodes !== undefined ? { codes: normalizedCodes } : {}),
    ...(normalizedPeriodicity !== undefined ? { periodicity: normalizedPeriodicity } : {}),
    ...(normalizedSyncStatus !== undefined ? { sync_status: normalizedSyncStatus } : {}),
  };
};

const normalizeObservationFilterForCache = (
  filter: InsObservationFilter | undefined
): InsObservationFilter | undefined => {
  if (filter === undefined) {
    return undefined;
  }

  const normalizedTerritoryCodes = toSortedUniqueArray(filter.territory_codes);
  const normalizedSirutaCodes = toSortedUniqueArray(filter.siruta_codes);
  const normalizedTerritoryLevels = toSortedUniqueArray(filter.territory_levels);
  const normalizedUnitCodes = toSortedUniqueArray(filter.unit_codes);
  const normalizedClassificationValueCodes = toSortedUniqueArray(filter.classification_value_codes);
  const normalizedClassificationTypeCodes = toSortedUniqueArray(filter.classification_type_codes);

  const normalized: InsObservationFilter = {
    ...filter,
    ...(normalizedTerritoryCodes !== undefined
      ? { territory_codes: normalizedTerritoryCodes }
      : {}),
    ...(normalizedSirutaCodes !== undefined ? { siruta_codes: normalizedSirutaCodes } : {}),
    ...(normalizedTerritoryLevels !== undefined
      ? { territory_levels: normalizedTerritoryLevels }
      : {}),
    ...(normalizedUnitCodes !== undefined ? { unit_codes: normalizedUnitCodes } : {}),
    ...(normalizedClassificationValueCodes !== undefined
      ? { classification_value_codes: normalizedClassificationValueCodes }
      : {}),
    ...(normalizedClassificationTypeCodes !== undefined
      ? { classification_type_codes: normalizedClassificationTypeCodes }
      : {}),
  };

  if (filter.period !== undefined) {
    const selection = filter.period.selection;
    if ('dates' in selection && selection.dates !== undefined) {
      normalized.period = {
        ...filter.period,
        selection: {
          dates: toSortedUniqueArray(selection.dates) ?? [],
        },
      };
    } else if ('interval' in selection) {
      normalized.period = {
        ...filter.period,
        selection: {
          interval: {
            start: selection.interval.start,
            end: selection.interval.end,
          },
        },
      };
    }
  }

  return normalized;
};

const normalizeObservationInputForCache = (
  input: ListInsObservationsInput
): ListInsObservationsInput => {
  const normalizedFilter = normalizeObservationFilterForCache(input.filter);

  return {
    ...input,
    dataset_codes: toSortedUniqueArray(input.dataset_codes) ?? [],
    ...(normalizedFilter !== undefined ? { filter: normalizedFilter } : {}),
  };
};

const normalizeLatestDatasetValuesInputForCache = (
  input: ListInsLatestDatasetValuesInput
): ListInsLatestDatasetValuesInput => {
  const normalizedPreferredCodes = toSortedUniqueArray(input.preferred_classification_codes);

  return {
    ...input,
    entity: { ...input.entity },
    // Preserve dataset_codes order: response order follows input order.
    dataset_codes: [...input.dataset_codes],
    ...(normalizedPreferredCodes !== undefined
      ? { preferred_classification_codes: normalizedPreferredCodes }
      : {}),
  };
};

const normalizeOptionalTrimmedValue = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Generic cache wrapper for Result-returning async functions.
 */
const wrapWithCache = <TArgs extends unknown[], TValue, TError>(
  fn: (...args: TArgs) => Promise<Result<TValue, TError>>,
  cache: SilentCachePort,
  keyGenerator: (args: TArgs) => string,
  ttlMs?: number
): ((...args: TArgs) => Promise<Result<TValue, TError>>) => {
  return async (...args: TArgs): Promise<Result<TValue, TError>> => {
    const key = keyGenerator(args);

    // Check cache first
    const cached = await cache.get(key);
    if (cached !== undefined) {
      return ok(cached as TValue);
    }

    // Execute original function
    const result = await fn(...args);

    // Cache only successful results
    if (result.isOk()) {
      await cache.set(key, result.value, ttlMs !== undefined ? { ttlMs } : undefined);
    }

    return result;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// INS Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapInsRepo = (
  repo: InsRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): InsRepository => ({
  listDatasets: wrapWithCache(
    repo.listDatasets.bind(repo),
    cache,
    ([filter, limit, offset]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'listDatasets',
        filter: normalizeDatasetFilterForCache(filter),
        limit,
        offset,
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),

  listContexts: wrapWithCache(
    repo.listContexts.bind(repo),
    cache,
    ([filter, limit, offset]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'listContexts',
        filter,
        limit,
        offset,
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),

  getDatasetByCode: wrapWithCache(
    repo.getDatasetByCode.bind(repo),
    cache,
    ([code]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'getDatasetByCode',
        code,
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),

  listDimensions: wrapWithCache(
    repo.listDimensions.bind(repo),
    cache,
    ([matrixId]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'listDimensions',
        matrixId,
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),

  listDimensionValues: wrapWithCache(
    repo.listDimensionValues.bind(repo),
    cache,
    ([matrixId, dimIndex, filter, limit, offset]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'listDimensionValues',
        matrixId,
        dimIndex,
        filter,
        limit,
        offset,
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),

  listObservations: wrapWithCache(
    repo.listObservations.bind(repo),
    cache,
    ([input]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'listObservations',
        input: normalizeObservationInputForCache(input),
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),

  listLatestDatasetValues: wrapWithCache(
    repo.listLatestDatasetValues.bind(repo),
    cache,
    ([input]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'listLatestDatasetValues',
        input: normalizeLatestDatasetValuesInputForCache(input),
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),

  listUatDatasetsWithObservations: wrapWithCache(
    repo.listUatDatasetsWithObservations.bind(repo),
    cache,
    ([sirutaCode, contextCode, period]) =>
      keyBuilder.fromFilter(CacheNamespace.INS_QUERIES, {
        method: 'listUatDatasetsWithObservations',
        sirutaCode,
        contextCode: normalizeOptionalTrimmedValue(contextCode),
        period: normalizeOptionalTrimmedValue(period),
      } as FilterLike),
    INS_CACHE_TTL_MS
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// County Analytics Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapCountyAnalyticsRepo = (
  repo: CountyAnalyticsRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): CountyAnalyticsRepository => ({
  getHeatmapData: wrapWithCache<
    [CommonAnalyticsFilter],
    HeatmapCountyDataPoint[],
    CountyAnalyticsError
  >(repo.getHeatmapData.bind(repo), cache, ([filter]) =>
    keyBuilder.fromFilter(CacheNamespace.ANALYTICS_COUNTY, filter as unknown as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// UAT Analytics Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapUATAnalyticsRepo = (
  repo: UATAnalyticsRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): UATAnalyticsRepository => ({
  getHeatmapData: wrapWithCache<[CommonAnalyticsFilter], HeatmapUATDataPoint[], UATAnalyticsError>(
    repo.getHeatmapData.bind(repo),
    cache,
    ([filter]) =>
      keyBuilder.fromFilter(CacheNamespace.ANALYTICS_UAT, filter as unknown as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Entity Analytics Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapEntityAnalyticsRepo = (
  repo: EntityAnalyticsRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): EntityAnalyticsRepository => ({
  getEntityAnalytics: wrapWithCache<
    [
      CommonAnalyticsFilter,
      PeriodFactorMap,
      PaginationParams,
      EntityAnalyticsSort,
      AggregateFilters?,
    ],
    EntityAnalyticsResult,
    EntityAnalyticsError
  >(
    repo.getEntityAnalytics.bind(repo),
    cache,
    ([filter, factorMap, pagination, sort, aggFilters]) =>
      keyBuilder.fromFilter(CacheNamespace.ANALYTICS_ENTITY, {
        filter,
        factorMap: Object.fromEntries(factorMap),
        pagination,
        sort,
        aggFilters,
      } as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution Analytics Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapExecutionAnalyticsRepo = (
  repo: AnalyticsRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): AnalyticsRepository => ({
  getAggregatedSeries: wrapWithCache<[AnalyticsFilter], DataSeries, AnalyticsError>(
    repo.getAggregatedSeries.bind(repo),
    cache,
    ([filter]) =>
      keyBuilder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter as unknown as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated Line Items Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapAggregatedLineItemsRepo = (
  repo: AggregatedLineItemsRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): AggregatedLineItemsRepository => ({
  getClassificationPeriodData: wrapWithCache<
    [CommonAnalyticsFilter],
    ClassificationPeriodResult,
    AggregatedLineItemsError
  >(repo.getClassificationPeriodData.bind(repo), cache, ([filter]) =>
    keyBuilder.fromFilter(CacheNamespace.ANALYTICS_AGGREGATED, {
      method: 'getClassificationPeriodData',
      filter,
    } as FilterLike)
  ),

  getNormalizedAggregatedItems: wrapWithCache<
    [CommonAnalyticsFilter, AggPeriodFactorMap, AggPaginationParams, AggAggregateFilters?],
    NormalizedAggregatedResult,
    AggregatedLineItemsError
  >(
    repo.getNormalizedAggregatedItems.bind(repo),
    cache,
    ([filter, factorMap, pagination, aggFilters]) =>
      keyBuilder.fromFilter(CacheNamespace.ANALYTICS_AGGREGATED, {
        method: 'getNormalizedAggregatedItems',
        filter,
        factorMap: Object.fromEntries(factorMap),
        pagination,
        aggFilters,
      } as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget Sector Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapBudgetSectorRepo = (
  repo: BudgetSectorRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): BudgetSectorRepository => ({
  findById: wrapWithCache<[number], BudgetSector | null, BudgetSectorError>(
    repo.findById.bind(repo),
    cache,
    ([id]) => keyBuilder.build(CacheNamespace.REF_BUDGET_SECTORS, `id:${String(id)}`)
  ),

  list: wrapWithCache<
    [BudgetSectorFilter | undefined, number, number],
    BudgetSectorConnection,
    BudgetSectorError
  >(repo.list.bind(repo), cache, ([filter, limit, offset]) =>
    keyBuilder.fromFilter(CacheNamespace.REF_BUDGET_SECTORS, {
      filter,
      limit,
      offset,
    } as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Funding Source Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapFundingSourceRepo = (
  repo: FundingSourceRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): FundingSourceRepository => ({
  findById: wrapWithCache<[number], FundingSource | null, FundingSourceError>(
    repo.findById.bind(repo),
    cache,
    ([id]) => keyBuilder.build(CacheNamespace.REF_FUNDING_SOURCES, `id:${String(id)}`)
  ),

  list: wrapWithCache<
    [FundingSourceFilter | undefined, number, number],
    FundingSourceConnection,
    FundingSourceError
  >(repo.list.bind(repo), cache, ([filter, limit, offset]) =>
    keyBuilder.fromFilter(CacheNamespace.REF_FUNDING_SOURCES, {
      filter,
      limit,
      offset,
    } as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Funding Source Execution Line Item Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapFundingSourceLineItemRepo = (
  repo: FundingSourceLineItemRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): FundingSourceLineItemRepository => ({
  listByFundingSource: wrapWithCache<
    [FundingSourceLineItemFilter, number, number],
    FundingSourceLineItemConnection,
    FundingSourceError
  >(repo.listByFundingSource.bind(repo), cache, ([filter, limit, offset]) =>
    keyBuilder.fromFilter(CacheNamespace.REF_FUNDING_SOURCES, {
      method: 'listByFundingSource',
      filter,
      limit,
      offset,
    } as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Functional Classification Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapFunctionalClassificationRepo = (
  repo: FunctionalClassificationRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): FunctionalClassificationRepository => ({
  getByCode: wrapWithCache<[string], FunctionalClassification | null, ClassificationError>(
    repo.getByCode.bind(repo),
    cache,
    ([code]) => keyBuilder.build(CacheNamespace.REF_CLASSIFICATION, `functional:${code}`)
  ),

  list: wrapWithCache<
    [FunctionalClassificationFilter, number, number],
    FunctionalClassificationConnection,
    ClassificationError
  >(repo.list.bind(repo), cache, ([filter, limit, offset]) =>
    keyBuilder.fromFilter(CacheNamespace.REF_CLASSIFICATION, {
      type: 'functional',
      filter,
      limit,
      offset,
    } as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Economic Classification Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapEconomicClassificationRepo = (
  repo: EconomicClassificationRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): EconomicClassificationRepository => ({
  getByCode: wrapWithCache<[string], EconomicClassification | null, ClassificationError>(
    repo.getByCode.bind(repo),
    cache,
    ([code]) => keyBuilder.build(CacheNamespace.REF_CLASSIFICATION, `economic:${code}`)
  ),

  list: wrapWithCache<
    [EconomicClassificationFilter, number, number],
    EconomicClassificationConnection,
    ClassificationError
  >(repo.list.bind(repo), cache, ([filter, limit, offset]) =>
    keyBuilder.fromFilter(CacheNamespace.REF_CLASSIFICATION, {
      type: 'economic',
      filter,
      limit,
      offset,
    } as FilterLike)
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Population Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapPopulationRepo = (
  repo: PopulationRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): PopulationRepository => ({
  getCountryPopulation: wrapWithCache<[], Decimal, PopulationError>(
    repo.getCountryPopulation.bind(repo),
    cache,
    () => keyBuilder.build(CacheNamespace.NORMALIZATION_POPULATION, 'country')
  ),

  getFilteredPopulation: wrapWithCache<[CommonAnalyticsFilter], Decimal, PopulationError>(
    repo.getFilteredPopulation.bind(repo),
    cache,
    ([filter]) =>
      keyBuilder.fromFilter(
        CacheNamespace.NORMALIZATION_POPULATION,
        filter as unknown as FilterLike
      )
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution Line Items Repository Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export const wrapExecutionLineItemsRepo = (
  repo: ExecutionLineItemRepository,
  cache: SilentCachePort,
  keyBuilder: KeyBuilder
): ExecutionLineItemRepository => ({
  findById: repo.findById.bind(repo), // Not cached - single item lookups are fast

  list: wrapWithCache<
    [ExecutionLineItemFilter, SortInput, number, number],
    ExecutionLineItemConnection,
    ExecutionLineItemError
  >(repo.list.bind(repo), cache, ([filter, sort, limit, offset]) =>
    keyBuilder.fromFilter(CacheNamespace.EXECUTION_LINE_ITEMS, {
      filter,
      sort,
      limit,
      offset,
    } as FilterLike)
  ),
});
