import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { extractYearRangeFromSelection } from '@/common/types/temporal.js';
import {
  computeMultiplier,
  needsNormalization,
  periodLabelFromParts,
  type CommitmentsRepository,
} from '@/modules/commitments/index.js';

import { normalizeCommitmentsSeriesInput } from './filter-normalizers.js';
import { createProviderError, type GroupedSeriesError } from '../../core/errors.js';

import type { CommitmentsMapSeries, GroupedSeriesWarning } from '../../core/types.js';
import type { NormalizationFactors, NormalizationService } from '@/modules/normalization/index.js';

export interface CommitmentsSeriesExtractionDeps {
  commitmentsRepo: CommitmentsRepository;
  normalizationService: NormalizationService;
}

export interface CommitmentsSeriesExtractionOutput {
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

function createEmptyFactors(): NormalizationFactors {
  return {
    cpi: new Map(),
    eur: new Map(),
    usd: new Map(),
    gdp: new Map(),
    population: new Map(),
  };
}

export async function extractCommitmentsSeriesVector(
  deps: CommitmentsSeriesExtractionDeps,
  series: CommitmentsMapSeries,
  sirutaUniverse: Set<string>
): Promise<Result<CommitmentsSeriesExtractionOutput, GroupedSeriesError>> {
  const normalized = normalizeCommitmentsSeriesInput(series);
  if (normalized.isErr()) {
    return err(normalized.error);
  }

  const warnings = [...normalized.value.warnings];
  const filter = normalized.value.filter;
  const config = {
    normalization: normalized.value.transforms.normalization,
    currency: normalized.value.transforms.currency,
    inflation_adjusted: normalized.value.transforms.inflationAdjusted,
  } as const;

  const rowsResult = await deps.commitmentsRepo.getUatMetricRows(filter, series.metric);
  if (rowsResult.isErr()) {
    return err(
      createProviderError(
        `Failed to extract commitments map data for series ${series.id}`,
        rowsResult.error
      )
    );
  }

  const frequency = filter.report_period.type;
  const { startYear, endYear } = extractYearRangeFromSelection(filter.report_period.selection);

  let factors = createEmptyFactors();
  if (needsNormalization(config)) {
    try {
      factors = await deps.normalizationService.generateFactors(frequency, startYear, endYear);
    } catch (error) {
      return err(
        createProviderError(
          `Failed to build normalization factors for commitments series ${series.id}`,
          error
        )
      );
    }
  }

  const aggregateBySiruta = new Map<string, Decimal>();
  for (const row of rowsResult.value) {
    const sirutaCode = row.siruta_code.trim();
    if (sirutaCode === '' || !sirutaUniverse.has(sirutaCode)) {
      continue;
    }

    const populationDenominator =
      row.population !== null && row.population > 0 ? new Decimal(row.population) : undefined;
    if (config.normalization === 'per_capita' && populationDenominator === undefined) {
      warnings.push({
        type: 'missing_population',
        message: 'Per-capita value is undefined because population is missing',
        seriesId: series.id,
        sirutaCode,
      });
      continue;
    }

    const periodLabel = periodLabelFromParts(row.year, row.period_value, frequency);
    const multiplier = computeMultiplier(periodLabel, config, factors, populationDenominator);
    const normalizedValue = row.amount.mul(multiplier);

    if (!normalizedValue.isFinite()) {
      continue;
    }

    const existing = aggregateBySiruta.get(sirutaCode) ?? new Decimal(0);
    aggregateBySiruta.set(sirutaCode, existing.plus(normalizedValue));
  }

  const vector = new Map<string, number | undefined>();
  for (const [sirutaCode, value] of aggregateBySiruta.entries()) {
    const numericValue = value.toNumber();
    if (Number.isFinite(numericValue)) {
      vector.set(sirutaCode, numericValue);
    }
  }

  return ok({
    valuesBySirutaCode: vector,
    unit: resolveUnit(config.normalization, config.currency),
    warnings,
  });
}
