import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { createProviderError, type GroupedSeriesError } from '../../core/errors.js';

import type { GroupedSeriesWarning, InsMapSeries } from '../../core/types.js';
import type { InsObservation, InsObservationFilter, InsRepository } from '@/modules/ins/index.js';

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

interface PeriodBucketValue {
  observationId: string;
  value: Decimal;
}

export interface InsSeriesExtractionOutput {
  valuesBySirutaCode: Map<string, number | undefined>;
  unit?: string;
  warnings: GroupedSeriesWarning[];
}

function resolveObservationUnit(observation: InsObservation): string | undefined {
  const symbol = observation.unit?.symbol?.trim();
  if (symbol !== undefined && symbol !== '') {
    return symbol;
  }

  const code = observation.unit?.code.trim();
  if (code !== undefined && code !== '') {
    return code;
  }

  const ro = observation.unit?.name_ro?.trim();
  if (ro !== undefined && ro !== '') {
    return ro;
  }

  const en = observation.unit?.name_en?.trim();
  if (en !== undefined && en !== '') {
    return en;
  }

  return undefined;
}

function matchesClassificationSelections(
  observation: InsObservation,
  selections: Record<string, string[]> | undefined
): boolean {
  if (selections === undefined || Object.keys(selections).length === 0) {
    return true;
  }

  for (const [typeCode, selectedCodes] of Object.entries(selections)) {
    if (selectedCodes.length === 0) {
      continue;
    }

    const hasMatch = observation.classifications.some(
      (classification) =>
        classification.type_code === typeCode && selectedCodes.includes(classification.code)
    );
    if (!hasMatch) {
      return false;
    }
  }

  return true;
}

function aggregatePeriodValues(
  values: PeriodBucketValue[],
  mode: 'sum' | 'average' | 'first'
): Decimal {
  if (values.length === 0) {
    return new Decimal(0);
  }

  if (mode === 'first') {
    const sorted = [...values].sort((left, right) =>
      left.observationId.localeCompare(right.observationId)
    );
    return sorted[0]?.value ?? new Decimal(0);
  }

  const sum = values.reduce((acc, item) => acc.plus(item.value), new Decimal(0));
  if (mode === 'average') {
    return sum.div(values.length);
  }

  return sum;
}

function buildObservationFilter(series: InsMapSeries): InsObservationFilter {
  const filter: InsObservationFilter = {};

  if (series.territoryCodes !== undefined && series.territoryCodes.length > 0) {
    filter.territory_codes = series.territoryCodes;
  }
  if (series.sirutaCodes !== undefined && series.sirutaCodes.length > 0) {
    filter.siruta_codes = series.sirutaCodes;
  }
  if (series.unitCodes !== undefined && series.unitCodes.length > 0) {
    filter.unit_codes = series.unitCodes;
  }
  if (series.period !== undefined) {
    filter.period = series.period;
  }
  if (series.hasValue !== undefined) {
    filter.has_value = series.hasValue;
  }

  const selections = series.classificationSelections;
  if (selections !== undefined) {
    const typeCodes = Object.keys(selections).filter((code) => code.trim() !== '');
    const valueCodes = Array.from(
      new Set(
        Object.values(selections)
          .flatMap((codes) => codes)
          .map((code) => code.trim())
          .filter((code) => code !== '')
      )
    );

    if (typeCodes.length > 0) {
      filter.classification_type_codes = typeCodes;
    }
    if (valueCodes.length > 0) {
      filter.classification_value_codes = valueCodes;
    }
  }

  return filter;
}

export async function extractInsSeriesVector(
  insRepo: InsRepository,
  series: InsMapSeries,
  sirutaUniverse: Set<string>
): Promise<Result<InsSeriesExtractionOutput, GroupedSeriesError>> {
  const warnings: GroupedSeriesWarning[] = [];

  if (series.datasetCode === undefined || series.datasetCode.trim() === '') {
    warnings.push({
      type: 'missing_dataset_code',
      message: 'INS datasetCode is required to extract map data',
      seriesId: series.id,
    });
    return ok({
      valuesBySirutaCode: new Map(),
      ...(series.unit !== undefined ? { unit: series.unit } : {}),
      warnings,
    });
  }

  const datasetCode = series.datasetCode.trim();
  const filter = buildObservationFilter(series);

  const observations: InsObservation[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageResult = await insRepo.listObservations({
      dataset_codes: [datasetCode],
      filter,
      limit: PAGE_SIZE,
      offset,
    });

    if (pageResult.isErr()) {
      return err(
        createProviderError(
          `Failed to extract INS map data for series ${series.id}`,
          pageResult.error
        )
      );
    }

    observations.push(...pageResult.value.nodes);
    if (!pageResult.value.pageInfo.hasNextPage) {
      break;
    }

    if (page === MAX_PAGES - 1) {
      warnings.push({
        type: 'page_limit_reached',
        message: `INS extraction reached pagination cap (${String(MAX_PAGES)} pages x ${String(PAGE_SIZE)} rows); output may be incomplete`,
        seriesId: series.id,
        details: {
          maxPages: MAX_PAGES,
          pageSize: PAGE_SIZE,
          loadedObservationCount: observations.length,
          reportedTotalCount: pageResult.value.pageInfo.totalCount,
        },
      });
      break;
    }

    offset += PAGE_SIZE;
  }

  const selections = series.classificationSelections;
  const periodBucketsBySiruta = new Map<string, Map<string, PeriodBucketValue[]>>();
  const unitSet = new Set<string>();
  const aggregation = series.aggregation ?? 'sum';

  for (const observation of observations) {
    const sirutaCode = observation.territory?.siruta_code?.trim();
    if (sirutaCode === undefined || sirutaCode === '' || !sirutaUniverse.has(sirutaCode)) {
      continue;
    }

    if (!matchesClassificationSelections(observation, selections)) {
      continue;
    }

    const value = observation.value;
    if (value === null) {
      continue;
    }

    const periodKey = observation.time_period.iso_period;
    let bucketByPeriod = periodBucketsBySiruta.get(sirutaCode);
    if (bucketByPeriod === undefined) {
      bucketByPeriod = new Map();
      periodBucketsBySiruta.set(sirutaCode, bucketByPeriod);
    }

    let bucket = bucketByPeriod.get(periodKey);
    if (bucket === undefined) {
      bucket = [];
      bucketByPeriod.set(periodKey, bucket);
    }

    bucket.push({
      observationId: observation.id,
      value,
    });

    const unit = resolveObservationUnit(observation);
    if (unit !== undefined) {
      unitSet.add(unit);
    }
  }

  if ((series.unit === undefined || series.unit.trim() === '') && unitSet.size > 1) {
    warnings.push({
      type: 'mixed_unit',
      message: 'INS series has mixed units; consider filtering by a single unit',
      seriesId: series.id,
      details: {
        units: Array.from(unitSet.values()).sort((left, right) => left.localeCompare(right)),
      },
    });
  }

  const valuesBySirutaCode = new Map<string, number | undefined>();
  for (const [sirutaCode, periodBuckets] of periodBucketsBySiruta.entries()) {
    let total = new Decimal(0);

    for (const values of periodBuckets.values()) {
      const periodValue = aggregatePeriodValues(values, aggregation);
      total = total.plus(periodValue);
    }

    const numericValue = total.toNumber();
    if (Number.isFinite(numericValue)) {
      valuesBySirutaCode.set(sirutaCode, numericValue);
    }
  }

  const fallbackUnit = unitSet.size === 1 ? Array.from(unitSet)[0] : undefined;

  return ok({
    valuesBySirutaCode,
    ...(series.unit !== undefined && series.unit.trim() !== ''
      ? { unit: series.unit.trim() }
      : fallbackUnit !== undefined
        ? { unit: fallbackUnit }
        : {}),
    warnings,
  });
}
