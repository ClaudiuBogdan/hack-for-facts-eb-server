import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { CacheNamespace, type KeyBuilder, type SilentCachePort } from '@/infra/cache/index.js';

import { extractCommitmentsSeriesVector } from './extract-commitments-series.js';
import { extractExecutionSeriesVector } from './extract-execution-series.js';
import { extractInsSeriesVector } from './extract-ins-series.js';
import { extractUploadedDatasetSeriesVector } from './extract-uploaded-dataset-series.js';
import {
  normalizeCommitmentsSeriesInput,
  normalizeExecutionSeriesInput,
} from './filter-normalizers.js';
import {
  createInvalidInputError,
  createNotFoundError,
  createProviderError,
} from '../../core/errors.js';

import type { GroupedSeriesProvider } from '../../core/ports.js';
import type {
  CommitmentsMapSeries,
  ExecutionMapSeries,
  GroupedSeriesWarning,
  GroupedSeriesDataRequest,
  InsMapSeries,
  MapRequestSeries,
  MapSeriesVector,
  UploadedMapDatasetSeries,
} from '../../core/types.js';
import type { ReportPeriodInput } from '@/common/types/analytics.js';
import type { BudgetDbClient } from '@/infra/database/client.js';
import type { AdvancedMapDatasetRepository } from '@/modules/advanced-map-datasets/index.js';
import type { CommitmentsRepository } from '@/modules/commitments/index.js';
import type { InsRepository } from '@/modules/ins/index.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { UATAnalyticsRepository } from '@/modules/uat-analytics/index.js';

interface SirutaRow {
  siruta_code: string;
}

const DEFAULT_SERIES_CACHE_TTL_MS = 60 * 60 * 1000;
const SERIES_CACHE_KEY_VERSION = 2;
const SERIES_CACHE_ENTRY_VERSION = 1;
const SET_LIKE_FILTER_ARRAY_KEYS = [
  'report_ids',
  'entity_cuis',
  'functional_codes',
  'functional_prefixes',
  'economic_codes',
  'economic_prefixes',
  'funding_source_ids',
  'budget_sector_ids',
  'expense_types',
  'program_codes',
  'county_codes',
  'regions',
  'uat_ids',
  'entity_types',
] as const;

interface CachedSeriesWarning {
  type: string;
  message: string;
  sirutaCode?: string;
  details?: Record<string, unknown>;
}

interface CachedSeriesVectorEntry {
  version: number;
  seriesType: MapRequestSeries['type'];
  unit?: string;
  valuesBySirutaCode: Record<string, number>;
  warnings: CachedSeriesWarning[];
}

export interface MakeDbAdvancedMapAnalyticsGroupedSeriesProviderDeps {
  budgetDb: BudgetDbClient;
  datasetRepo?: AdvancedMapDatasetRepository;
  commitmentsRepo: CommitmentsRepository;
  insRepo: InsRepository;
  normalizationService: NormalizationService;
  uatAnalyticsRepo: UATAnalyticsRepository;
  cache?: SilentCachePort;
  keyBuilder?: KeyBuilder;
  seriesCacheTtlMs?: number;
}

function resolveSeriesUnit(
  preferredUnit: string | undefined,
  fallbackUnit: string | undefined
): string | undefined {
  const preferred = preferredUnit?.trim();
  if (preferred !== undefined && preferred !== '') {
    return preferred;
  }

  const fallback = fallbackUnit?.trim();
  if (fallback !== undefined && fallback !== '') {
    return fallback;
  }

  return undefined;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSortedUniqueStrings(values: string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }

  const normalized = Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value !== ''))
  ).sort((left, right) => left.localeCompare(right));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizePeriodForKey(
  period: ReportPeriodInput | undefined
): Record<string, unknown> | undefined {
  if (period === undefined) {
    return undefined;
  }

  const selection = period.selection;
  if ('interval' in selection && selection.interval !== undefined) {
    return {
      type: period.type,
      selection: {
        interval: {
          start: selection.interval.start,
          end: selection.interval.end,
        },
      },
    };
  }

  const dates = 'dates' in selection ? selection.dates : [];
  return {
    type: period.type,
    selection: {
      dates: toSortedUniqueStrings([...dates]) ?? [],
    },
  };
}

function normalizeInsClassificationsForKey(
  selections: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (selections === undefined) {
    return undefined;
  }

  const normalizedEntries = Object.entries(selections)
    .map(([typeCode, codes]) => [typeCode.trim(), toSortedUniqueStrings(codes)] as const)
    .filter(([typeCode, codes]) => typeCode !== '' && codes !== undefined);

  if (normalizedEntries.length === 0) {
    return undefined;
  }

  normalizedEntries.sort(([left], [right]) => left.localeCompare(right));

  const normalized: Record<string, string[]> = {};
  for (const [typeCode, codes] of normalizedEntries) {
    if (codes !== undefined) {
      normalized[typeCode] = codes;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeSetLikeArrayValueForKey(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter((entry): entry is string => typeof entry === 'string');
  return toSortedUniqueStrings(values);
}

function normalizeSetLikeFilterObjectForKey(
  filter: Record<string, unknown>
): Record<string, unknown> {
  const normalizedFilter: Record<string, unknown> = { ...filter };

  for (const key of SET_LIKE_FILTER_ARRAY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(normalizedFilter, key)) {
      continue;
    }

    const normalizedValue = normalizeSetLikeArrayValueForKey(normalizedFilter[key]);
    if (normalizedValue !== undefined) {
      normalizedFilter[key] = normalizedValue;
    }
  }

  return normalizedFilter;
}

function normalizeSeriesFilterForCacheKey(
  filter: Record<string, unknown>
): Record<string, unknown> {
  const normalizedFilter = normalizeSetLikeFilterObjectForKey(filter);
  const rawExclude = normalizedFilter['exclude'];

  if (!isPlainObject(rawExclude)) {
    return normalizedFilter;
  }

  normalizedFilter['exclude'] = normalizeSetLikeFilterObjectForKey(rawExclude);
  return normalizedFilter;
}

function createExecutionSeriesCacheKeyPayload(
  granularity: GroupedSeriesDataRequest['granularity'],
  series: ExecutionMapSeries
) {
  const normalized = normalizeExecutionSeriesInput(series);
  if (normalized.isErr()) {
    return err(normalized.error);
  }

  const normalizedFilter = normalizeSeriesFilterForCacheKey({
    ...normalized.value.filter,
    report_period: normalizePeriodForKey(normalized.value.filter.report_period),
    normalization: normalized.value.options.normalization,
    currency: normalized.value.options.currency,
    inflation_adjusted: normalized.value.options.inflationAdjusted,
    show_period_growth: series.filter.show_period_growth === true,
  });

  return ok({
    version: SERIES_CACHE_KEY_VERSION,
    granularity,
    seriesType: series.type,
    filter: normalizedFilter,
    options: normalized.value.options,
  });
}

function createCommitmentsSeriesCacheKeyPayload(
  granularity: GroupedSeriesDataRequest['granularity'],
  series: CommitmentsMapSeries
) {
  const normalized = normalizeCommitmentsSeriesInput(series);
  if (normalized.isErr()) {
    return err(normalized.error);
  }

  const normalizedFilter = normalizeSeriesFilterForCacheKey({
    ...normalized.value.filter,
    report_period: normalizePeriodForKey(normalized.value.filter.report_period),
  });

  return ok({
    version: SERIES_CACHE_KEY_VERSION,
    granularity,
    seriesType: series.type,
    metric: series.metric,
    filter: normalizedFilter,
    transforms: normalized.value.transforms,
  });
}

function createInsSeriesCacheKeyPayload(
  granularity: GroupedSeriesDataRequest['granularity'],
  series: InsMapSeries
): Record<string, unknown> {
  return {
    version: SERIES_CACHE_KEY_VERSION,
    granularity,
    seriesType: series.type,
    datasetCode: trimToUndefined(series.datasetCode),
    aggregation: series.aggregation ?? 'sum',
    period: normalizePeriodForKey(series.period),
    territoryCodes: toSortedUniqueStrings(series.territoryCodes),
    sirutaCodes: toSortedUniqueStrings(series.sirutaCodes),
    unitCodes: toSortedUniqueStrings(series.unitCodes),
    classificationSelections: normalizeInsClassificationsForKey(series.classificationSelections),
    hasValue: series.hasValue,
  };
}

function createUploadedDatasetSeriesCacheKeyPayload(
  granularity: GroupedSeriesDataRequest['granularity'],
  series: UploadedMapDatasetSeries,
  requestUserId: string | undefined,
  resolvedDatasetId: string,
  datasetVersion: string
): Record<string, unknown> {
  return {
    version: SERIES_CACHE_KEY_VERSION,
    granularity,
    seriesType: series.type,
    datasetId: resolvedDatasetId,
    requestUserId: trimToUndefined(requestUserId),
    datasetVersion,
  };
}

function createSeriesCacheKeyPayload(
  granularity: GroupedSeriesDataRequest['granularity'],
  series: MapRequestSeries,
  requestUserId: string | undefined,
  options?: {
    resolvedDatasetId: string;
    datasetVersion: string;
  }
) {
  if (series.type === 'line-items-aggregated-yearly') {
    return createExecutionSeriesCacheKeyPayload(granularity, series);
  }

  if (series.type === 'commitments-analytics') {
    return createCommitmentsSeriesCacheKeyPayload(granularity, series);
  }

  if (series.type === 'uploaded-map-dataset') {
    if (options === undefined) {
      return err(
        createProviderError('Uploaded dataset cache key requires a resolved dataset head')
      );
    }

    return ok(
      createUploadedDatasetSeriesCacheKeyPayload(
        granularity,
        series,
        requestUserId,
        options.resolvedDatasetId,
        options.datasetVersion
      )
    );
  }

  return ok(createInsSeriesCacheKeyPayload(granularity, series));
}

function toCachedWarnings(warnings: GroupedSeriesWarning[]): CachedSeriesWarning[] {
  return warnings.map((warning) => ({
    type: warning.type,
    message: warning.message,
    ...(warning.sirutaCode !== undefined ? { sirutaCode: warning.sirutaCode } : {}),
    ...(warning.details !== undefined ? { details: warning.details } : {}),
  }));
}

function fromCachedWarnings(
  warnings: CachedSeriesWarning[],
  seriesId: string
): GroupedSeriesWarning[] {
  return warnings.map((warning) => ({
    type: warning.type,
    message: warning.message,
    seriesId,
    ...(warning.sirutaCode !== undefined ? { sirutaCode: warning.sirutaCode } : {}),
    ...(warning.details !== undefined ? { details: warning.details } : {}),
  }));
}

function toCachedValues(
  valuesBySirutaCode: Map<string, number | undefined>
): Record<string, number> {
  const values: Record<string, number> = {};

  for (const [sirutaCode, value] of valuesBySirutaCode.entries()) {
    if (sirutaCode.trim() !== '' && isFiniteNumber(value)) {
      values[sirutaCode] = value;
    }
  }

  return values;
}

function fromCachedValues(
  valuesBySirutaCode: Record<string, number>
): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>();

  for (const [sirutaCode, value] of Object.entries(valuesBySirutaCode)) {
    if (sirutaCode.trim() !== '' && isFiniteNumber(value)) {
      map.set(sirutaCode, value);
    }
  }

  return map;
}

function toCachedSeriesEntry(
  seriesType: MapRequestSeries['type'],
  unit: string | undefined,
  valuesBySirutaCode: Map<string, number | undefined>,
  warnings: GroupedSeriesWarning[]
): CachedSeriesVectorEntry {
  return {
    version: SERIES_CACHE_ENTRY_VERSION,
    seriesType,
    ...(unit !== undefined ? { unit } : {}),
    valuesBySirutaCode: toCachedValues(valuesBySirutaCode),
    warnings: toCachedWarnings(warnings),
  };
}

function readCachedSeriesEntry(
  value: unknown,
  expectedSeriesType: MapRequestSeries['type']
): CachedSeriesVectorEntry | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const version = value['version'];
  const seriesType = value['seriesType'];
  const valuesBySirutaCode = value['valuesBySirutaCode'];
  const warnings = value['warnings'];

  if (version !== SERIES_CACHE_ENTRY_VERSION || seriesType !== expectedSeriesType) {
    return undefined;
  }

  if (!isPlainObject(valuesBySirutaCode) || !Array.isArray(warnings)) {
    return undefined;
  }

  const parsedWarnings: CachedSeriesWarning[] = [];
  for (const warning of warnings) {
    if (!isPlainObject(warning)) {
      return undefined;
    }

    const type = warning['type'];
    const message = warning['message'];
    const sirutaCode = warning['sirutaCode'];
    const details = warning['details'];

    if (
      typeof type !== 'string' ||
      type.trim() === '' ||
      typeof message !== 'string' ||
      message.trim() === ''
    ) {
      return undefined;
    }

    if (sirutaCode !== undefined && typeof sirutaCode !== 'string') {
      return undefined;
    }

    if (details !== undefined && !isPlainObject(details)) {
      return undefined;
    }

    parsedWarnings.push({
      type,
      message,
      ...(sirutaCode !== undefined ? { sirutaCode } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }

  const parsedValues: Record<string, number> = {};
  for (const [sirutaCode, rawValue] of Object.entries(valuesBySirutaCode)) {
    if (isFiniteNumber(rawValue)) {
      parsedValues[sirutaCode] = rawValue;
    }
  }

  const unit = value['unit'];
  if (unit !== undefined && typeof unit !== 'string') {
    return undefined;
  }

  return {
    version: SERIES_CACHE_ENTRY_VERSION,
    seriesType: expectedSeriesType,
    ...(typeof unit === 'string' && unit.trim() !== '' ? { unit } : {}),
    valuesBySirutaCode: parsedValues,
    warnings: parsedWarnings,
  };
}

async function loadNonCountySirutaCodes(db: BudgetDbClient): Promise<string[]> {
  const nonCountyCondition = sql<boolean>`NOT (
    u.siruta_code = u.county_code
    OR (u.county_code = 'B' AND u.siruta_code = '179132')
  )`;

  const rows: SirutaRow[] = await db
    .selectFrom('uats as u')
    .select(['u.siruta_code'])
    .where(nonCountyCondition)
    .orderBy('u.siruta_code', 'asc')
    .execute();

  return rows.map((row) => row.siruta_code.trim()).filter((value) => value !== '');
}

export function makeDbAdvancedMapAnalyticsGroupedSeriesProvider(
  deps: MakeDbAdvancedMapAnalyticsGroupedSeriesProviderDeps
): GroupedSeriesProvider {
  const ttlMs = deps.seriesCacheTtlMs ?? DEFAULT_SERIES_CACHE_TTL_MS;
  const cache = deps.cache;
  const keyBuilder = deps.keyBuilder;

  return {
    async fetchGroupedSeriesVectors(
      request: GroupedSeriesDataRequest
    ): ReturnType<GroupedSeriesProvider['fetchGroupedSeriesVectors']> {
      try {
        const sirutaUniverse = await loadNonCountySirutaCodes(deps.budgetDb);
        const sirutaUniverseSet = new Set<string>(sirutaUniverse);

        const vectors: MapSeriesVector[] = [];
        const warnings: GroupedSeriesWarning[] = [];

        for (const series of request.series) {
          let cacheKey: string | undefined;
          if (
            series.type !== 'uploaded-map-dataset' &&
            cache !== undefined &&
            keyBuilder !== undefined
          ) {
            const keyPayloadResult = createSeriesCacheKeyPayload(
              request.granularity,
              series,
              request.requestUserId
            );
            if (keyPayloadResult.isErr()) {
              return err(keyPayloadResult.error);
            }

            cacheKey = keyBuilder.fromFilter(
              CacheNamespace.ADVANCED_MAP_ANALYTICS_SERIES,
              keyPayloadResult.value
            );

            const cachedEntry = readCachedSeriesEntry(await cache.get(cacheKey), series.type);
            if (cachedEntry !== undefined) {
              const cachedWarnings = fromCachedWarnings(cachedEntry.warnings, series.id);
              warnings.push(...cachedWarnings);
              const unit = resolveSeriesUnit(series.unit, cachedEntry.unit);
              vectors.push({
                seriesId: series.id,
                ...(unit !== undefined ? { unit } : {}),
                valuesBySirutaCode: fromCachedValues(cachedEntry.valuesBySirutaCode),
              });
              continue;
            }
          }

          if (series.type === 'line-items-aggregated-yearly') {
            const executionResult = await extractExecutionSeriesVector(
              {
                uatAnalyticsRepo: deps.uatAnalyticsRepo,
                normalizationService: deps.normalizationService,
              },
              series,
              sirutaUniverseSet
            );

            if (executionResult.isErr()) {
              return err(executionResult.error);
            }

            warnings.push(...executionResult.value.warnings);
            const extractedUnit = executionResult.value.unit;
            const unit = resolveSeriesUnit(series.unit, extractedUnit);
            vectors.push({
              seriesId: series.id,
              ...(unit !== undefined ? { unit } : {}),
              valuesBySirutaCode: executionResult.value.valuesBySirutaCode,
            });

            if (cache !== undefined && cacheKey !== undefined) {
              const cacheEntry = toCachedSeriesEntry(
                series.type,
                extractedUnit,
                executionResult.value.valuesBySirutaCode,
                executionResult.value.warnings
              );
              await cache.set(cacheKey, cacheEntry, { ttlMs });
            }
            continue;
          }

          if (series.type === 'commitments-analytics') {
            const commitmentsResult = await extractCommitmentsSeriesVector(
              {
                commitmentsRepo: deps.commitmentsRepo,
                normalizationService: deps.normalizationService,
              },
              series,
              sirutaUniverseSet
            );

            if (commitmentsResult.isErr()) {
              return err(commitmentsResult.error);
            }

            warnings.push(...commitmentsResult.value.warnings);
            const extractedUnit = commitmentsResult.value.unit;
            const unit = resolveSeriesUnit(series.unit, extractedUnit);
            vectors.push({
              seriesId: series.id,
              ...(unit !== undefined ? { unit } : {}),
              valuesBySirutaCode: commitmentsResult.value.valuesBySirutaCode,
            });

            if (cache !== undefined && cacheKey !== undefined) {
              const cacheEntry = toCachedSeriesEntry(
                series.type,
                extractedUnit,
                commitmentsResult.value.valuesBySirutaCode,
                commitmentsResult.value.warnings
              );
              await cache.set(cacheKey, cacheEntry, { ttlMs });
            }
            continue;
          }

          if (series.type === 'uploaded-map-dataset') {
            if (deps.datasetRepo === undefined) {
              return err(createProviderError('Advanced map dataset repository is not configured'));
            }

            const datasetId = trimToUndefined(series.datasetId);
            const datasetPublicId = trimToUndefined(series.datasetPublicId);
            const hasDatasetId = datasetId !== undefined;
            const hasDatasetPublicId = datasetPublicId !== undefined;
            if (hasDatasetId === hasDatasetPublicId) {
              return err(
                createInvalidInputError(
                  'uploaded-map-dataset series requires exactly one of datasetId or datasetPublicId'
                )
              );
            }

            const datasetResult = await deps.datasetRepo.getAccessibleDataset({
              ...(datasetId !== undefined ? { datasetId } : {}),
              ...(datasetPublicId !== undefined ? { datasetPublicId } : {}),
              ...(request.requestUserId !== undefined && request.requestUserId.trim() !== ''
                ? { requestUserId: request.requestUserId.trim() }
                : {}),
            });
            if (datasetResult.isErr()) {
              return err(createProviderError(datasetResult.error.message, datasetResult.error));
            }

            if (datasetResult.value === null) {
              return err(createNotFoundError('Uploaded map dataset not found'));
            }

            if (cache !== undefined && keyBuilder !== undefined) {
              const datasetVersion = (
                datasetResult.value.replacedAt ?? datasetResult.value.updatedAt
              ).toISOString();
              const keyPayloadResult = createSeriesCacheKeyPayload(
                request.granularity,
                series,
                request.requestUserId,
                {
                  resolvedDatasetId: datasetResult.value.id,
                  datasetVersion,
                }
              );
              if (keyPayloadResult.isErr()) {
                return err(keyPayloadResult.error);
              }

              cacheKey = keyBuilder.fromFilter(
                CacheNamespace.ADVANCED_MAP_ANALYTICS_SERIES,
                keyPayloadResult.value
              );

              const cachedEntry = readCachedSeriesEntry(await cache.get(cacheKey), series.type);
              if (cachedEntry !== undefined) {
                const cachedWarnings = fromCachedWarnings(cachedEntry.warnings, series.id);
                warnings.push(...cachedWarnings);
                const unit = resolveSeriesUnit(series.unit, cachedEntry.unit);
                vectors.push({
                  seriesId: series.id,
                  ...(unit !== undefined ? { unit } : {}),
                  valuesBySirutaCode: fromCachedValues(cachedEntry.valuesBySirutaCode),
                });
                continue;
              }
            }

            const extractedDatasetResult = await extractUploadedDatasetSeriesVector(
              datasetResult.value,
              sirutaUniverseSet
            );
            if (extractedDatasetResult.isErr()) {
              return err(extractedDatasetResult.error);
            }

            warnings.push(...extractedDatasetResult.value.warnings);
            const extractedUnit = datasetResult.value.unit ?? undefined;
            const unit = resolveSeriesUnit(series.unit, extractedUnit);
            vectors.push({
              seriesId: series.id,
              ...(unit !== undefined ? { unit } : {}),
              valuesBySirutaCode: extractedDatasetResult.value.valuesBySirutaCode,
            });

            if (cache !== undefined && cacheKey !== undefined) {
              const cacheEntry = toCachedSeriesEntry(
                series.type,
                extractedUnit,
                extractedDatasetResult.value.valuesBySirutaCode,
                extractedDatasetResult.value.warnings
              );
              await cache.set(cacheKey, cacheEntry, { ttlMs });
            }
            continue;
          }

          const insResult = await extractInsSeriesVector(deps.insRepo, series, sirutaUniverseSet);
          if (insResult.isErr()) {
            return err(insResult.error);
          }

          warnings.push(...insResult.value.warnings);
          const extractedUnit = insResult.value.unit;
          const unit = resolveSeriesUnit(series.unit, extractedUnit);
          vectors.push({
            seriesId: series.id,
            ...(unit !== undefined ? { unit } : {}),
            valuesBySirutaCode: insResult.value.valuesBySirutaCode,
          });

          if (cache !== undefined && cacheKey !== undefined) {
            const cacheEntry = toCachedSeriesEntry(
              series.type,
              extractedUnit,
              insResult.value.valuesBySirutaCode,
              insResult.value.warnings
            );
            await cache.set(cacheKey, cacheEntry, { ttlMs });
          }
        }

        return ok({
          sirutaUniverse,
          vectors,
          warnings,
        });
      } catch (error) {
        return err(
          createProviderError('Failed to extract advanced map analytics grouped series data', error)
        );
      }
    },
  };
}
