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
import {
  GROUPED_SERIES_RESERVED_ID_PREFIXES,
  GROUPED_SERIES_UNSAFE_CSV_ID_PREFIXES,
  type GroupedSeriesDataRequest,
  type GroupedSeriesMatrixData,
  type GroupedSeriesMatrixRow,
  type MapRequestSeries,
  type MapSeriesVector,
} from '../types.js';

import type { GroupedSeriesProvider } from '../ports.js';

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

function findReservedSeriesIdPrefix(series: MapRequestSeries[]): string | undefined {
  for (const item of series) {
    const seriesId = item.id.trim();
    const normalizedSeriesId = seriesId.toLowerCase();

    for (const prefix of GROUPED_SERIES_RESERVED_ID_PREFIXES) {
      if (normalizedSeriesId.startsWith(prefix)) {
        return seriesId;
      }
    }
  }

  return undefined;
}

function findUnsafeCsvSeriesIdPrefix(series: MapRequestSeries[]): string | undefined {
  for (const item of series) {
    const seriesId = item.id.trim();

    for (const prefix of GROUPED_SERIES_UNSAFE_CSV_ID_PREFIXES) {
      if (seriesId.startsWith(prefix)) {
        return seriesId;
      }
    }
  }

  return undefined;
}

export function validateGroupedSeriesRequestSeries(
  series: MapRequestSeries[]
): Result<void, GroupedSeriesError> {
  const duplicateSeriesId = findDuplicateSeriesId(series);
  if (duplicateSeriesId !== undefined) {
    if (duplicateSeriesId === '') {
      return err(createInvalidInputError('Series id cannot be empty'));
    }

    return err(createInvalidInputError(`Duplicate series id: ${duplicateSeriesId}`));
  }

  const reservedSeriesId = findReservedSeriesIdPrefix(series);
  if (reservedSeriesId !== undefined) {
    return err(
      createInvalidInputError(
        `Series id uses a reserved prefix: ${reservedSeriesId}. Reserved prefixes: ${GROUPED_SERIES_RESERVED_ID_PREFIXES.join(', ')}`
      )
    );
  }

  const unsafeCsvSeriesId = findUnsafeCsvSeriesIdPrefix(series);
  if (unsafeCsvSeriesId !== undefined) {
    return err(
      createInvalidInputError(
        `Series id uses an unsafe CSV prefix: ${unsafeCsvSeriesId}. Unsafe prefixes: ${GROUPED_SERIES_UNSAFE_CSV_ID_PREFIXES.join(', ')}`
      )
    );
  }

  return ok(undefined);
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

  const seriesValidationResult = validateGroupedSeriesRequestSeries(request.series);
  if (seriesValidationResult.isErr()) {
    return err(seriesValidationResult.error);
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
