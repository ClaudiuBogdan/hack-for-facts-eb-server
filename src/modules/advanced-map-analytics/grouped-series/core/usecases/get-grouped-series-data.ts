/**
 * Get Grouped Series Data Use Case
 *
 * Builds deterministic wide-matrix data for map rendering.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidInputError,
  createProviderError,
  type GroupedSeriesError,
} from '../errors.js';

import type { GroupedSeriesProvider } from '../ports.js';
import type {
  GroupedSeriesDataRequest,
  GroupedSeriesMatrixData,
  GroupedSeriesMatrixRow,
  MapRequestSeries,
  MapSeriesVector,
} from '../types.js';

export interface GetGroupedSeriesDataDeps {
  provider: GroupedSeriesProvider;
  now?: () => Date;
}

export interface GetGroupedSeriesDataInput {
  request: GroupedSeriesDataRequest;
}

function findDuplicateSeriesId(series: MapRequestSeries[]): string | undefined {
  const seen = new Set<string>();

  for (const item of series) {
    const seriesId = item.id.trim();
    if (seriesId.length === 0) {
      return '';
    }

    if (seen.has(seriesId)) {
      return seriesId;
    }

    seen.add(seriesId);
  }

  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeSirutaUniverse(input: string[]): string[] {
  const normalized = new Set<string>();

  for (const value of input) {
    const sirutaCode = value.trim();
    if (sirutaCode.length > 0) {
      normalized.add(sirutaCode);
    }
  }

  return Array.from(normalized).sort((left, right) => left.localeCompare(right));
}

function normalizeVector(vector: MapSeriesVector): MapSeriesVector {
  const normalizedValues = new Map<string, number | undefined>();

  for (const [sirutaCode, value] of vector.valuesBySirutaCode.entries()) {
    if (isFiniteNumber(value)) {
      normalizedValues.set(sirutaCode, value);
      continue;
    }

    normalizedValues.set(sirutaCode, undefined);
  }

  return {
    ...vector,
    valuesBySirutaCode: normalizedValues,
  };
}

export async function getGroupedSeriesData(
  deps: GetGroupedSeriesDataDeps,
  input: GetGroupedSeriesDataInput
): Promise<Result<GroupedSeriesMatrixData, GroupedSeriesError>> {
  const { request } = input;

  if (request.series.length === 0) {
    return err(createInvalidInputError('At least one series is required'));
  }

  const duplicateSeriesId = findDuplicateSeriesId(request.series);
  if (duplicateSeriesId !== undefined) {
    if (duplicateSeriesId === '') {
      return err(createInvalidInputError('Series id cannot be empty'));
    }

    return err(createInvalidInputError(`Duplicate series id: ${duplicateSeriesId}`));
  }

  let providerResult: Awaited<ReturnType<GroupedSeriesProvider['fetchGroupedSeriesVectors']>>;
  try {
    providerResult = await deps.provider.fetchGroupedSeriesVectors(request);
  } catch (error) {
    return err(createProviderError('Map series provider failed unexpectedly', error));
  }

  if (providerResult.isErr()) {
    return err(providerResult.error);
  }

  const seriesOrder = request.series.map((series) => series.id.trim());
  const vectorBySeriesId = new Map<string, MapSeriesVector>();
  const sirutaUniverse = normalizeSirutaUniverse(providerResult.value.sirutaUniverse);
  const sirutaUniverseSet = new Set<string>(sirutaUniverse);

  for (const vector of providerResult.value.vectors) {
    const normalizedVector = normalizeVector(vector);
    vectorBySeriesId.set(normalizedVector.seriesId, normalizedVector);
  }

  const rows: GroupedSeriesMatrixRow[] = sirutaUniverse.map((sirutaCode) => {
    const valuesBySeriesId = new Map<string, number | undefined>();

    for (const seriesId of seriesOrder) {
      const vector = vectorBySeriesId.get(seriesId);
      const value = vector?.valuesBySirutaCode.get(sirutaCode);

      if (value !== undefined && isFiniteNumber(value)) {
        valuesBySeriesId.set(seriesId, value);
      } else {
        valuesBySeriesId.set(seriesId, undefined);
      }
    }

    return {
      sirutaCode,
      valuesBySeriesId,
    };
  });

  const manifestSeries = seriesOrder.map((seriesId) => {
    const vector = vectorBySeriesId.get(seriesId);
    let definedValueCount = 0;

    if (vector !== undefined) {
      for (const [sirutaCode, value] of vector.valuesBySirutaCode.entries()) {
        if (
          value !== undefined &&
          isFiniteNumber(value) &&
          (sirutaUniverseSet.size === 0 || sirutaUniverseSet.has(sirutaCode))
        ) {
          definedValueCount += 1;
        }
      }
    }

    const unit = vector?.unit;

    return {
      series_id: seriesId,
      ...(unit !== undefined ? { unit } : {}),
      defined_value_count: definedValueCount,
    };
  });

  return ok({
    manifest: {
      generated_at: (deps.now ?? (() => new Date()))().toISOString(),
      format: 'wide_matrix_v1',
      granularity: 'UAT',
      series: manifestSeries,
    },
    seriesOrder,
    rows,
    warnings: providerResult.value.warnings,
  });
}
