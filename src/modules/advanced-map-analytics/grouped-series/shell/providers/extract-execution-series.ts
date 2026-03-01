import { err, ok, type Result } from 'neverthrow';

import { getHeatmapData, type UATAnalyticsRepository } from '@/modules/uat-analytics/index.js';

import { normalizeExecutionSeriesInput } from './filter-normalizers.js';
import { createProviderError, type GroupedSeriesError } from '../../core/errors.js';

import type { ExecutionMapSeries, GroupedSeriesWarning } from '../../core/types.js';
import type { NormalizationService } from '@/modules/normalization/index.js';

export interface ExecutionSeriesExtractionDeps {
  uatAnalyticsRepo: UATAnalyticsRepository;
  normalizationService: NormalizationService;
}

export interface ExecutionSeriesExtractionOutput {
  valuesBySirutaCode: Map<string, number | undefined>;
  unit: string;
  warnings: GroupedSeriesWarning[];
}

function resolveUnit(
  normalization: 'total' | 'per_capita' | 'percent_gdp',
  currency: string
): string {
  if (normalization === 'percent_gdp') {
    return '%';
  }

  if (normalization === 'per_capita') {
    return `${currency}/capita`;
  }

  return currency;
}

export async function extractExecutionSeriesVector(
  deps: ExecutionSeriesExtractionDeps,
  series: ExecutionMapSeries,
  sirutaUniverse: Set<string>
): Promise<Result<ExecutionSeriesExtractionOutput, GroupedSeriesError>> {
  const normalized = normalizeExecutionSeriesInput(series);
  if (normalized.isErr()) {
    return err(normalized.error);
  }

  const vector = new Map<string, number | undefined>();
  const warnings = [...normalized.value.warnings];

  const heatmapResult = await getHeatmapData(
    {
      repo: deps.uatAnalyticsRepo,
      normalizationService: deps.normalizationService,
    },
    {
      filter: normalized.value.filter,
      options: normalized.value.options,
    }
  );

  if (heatmapResult.isErr()) {
    return err(
      createProviderError(
        `Failed to extract execution map data for series ${series.id}`,
        heatmapResult.error
      )
    );
  }

  for (const point of heatmapResult.value) {
    const sirutaCode = point.siruta_code.trim();
    if (sirutaCode === '' || !sirutaUniverse.has(sirutaCode)) {
      continue;
    }

    const isPerCapitaWithoutPopulation =
      normalized.value.options.normalization === 'per_capita' &&
      (point.population === null || point.population <= 0);
    if (isPerCapitaWithoutPopulation) {
      warnings.push({
        type: 'missing_population',
        message: 'Per-capita value is undefined because population is missing',
        seriesId: series.id,
        sirutaCode,
      });
      continue;
    }

    if (!Number.isFinite(point.amount)) {
      continue;
    }

    vector.set(sirutaCode, point.amount);
  }

  return ok({
    valuesBySirutaCode: vector,
    unit: resolveUnit(normalized.value.options.normalization, normalized.value.options.currency),
    warnings,
  });
}
