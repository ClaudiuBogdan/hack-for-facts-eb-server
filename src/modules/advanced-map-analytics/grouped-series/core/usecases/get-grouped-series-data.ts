/**
 * Get Grouped Series Data Use Case
 *
 * Builds deterministic wide-matrix data for map rendering.
 */

import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidInputError,
  createProviderError,
  type GroupedSeriesError,
} from '../errors.js';
import { validateFinancialMapWork } from '../request-limits.js';
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

interface NormalizedVector {
  seriesId: string;
  unit?: string;
  valuesBySirutaCode: Map<string, string | undefined>;
}

// Accept decimal/scientific notation only, never executable spreadsheet cells.
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function normalizeVector(vector: MapSeriesVector): Result<NormalizedVector, GroupedSeriesError> {
  const valuesBySirutaCode = new Map<string, string | undefined>();
  for (const [sirutaCode, value] of vector.valuesBySirutaCode) {
    if (value === undefined) {
      valuesBySirutaCode.set(sirutaCode, undefined);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      return err(createProviderError('Map series provider returned an invalid decimal value'));
    }
    const text = typeof value === 'number' ? String(value) : value.trim();
    try {
      if (!DECIMAL_TEXT.test(text) || !new Decimal(text).isFinite()) {
        return err(createProviderError('Map series provider returned an invalid decimal value'));
      }
    } catch {
      return err(createProviderError('Map series provider returned an invalid decimal value'));
    }
    valuesBySirutaCode.set(sirutaCode, text);
  }
  return ok({ ...vector, seriesId: vector.seriesId.trim(), valuesBySirutaCode });
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

  const workValidation = validateFinancialMapWork(request);
  if (workValidation.isErr()) return err(workValidation.error);

  const groupKeys = new Set<string>();
  const sources = new Map(request.series.map((series) => [series.id, series]));
  if ((request.groups?.length ?? 0) > 256)
    return err(createInvalidInputError('Too many map groups'));
  for (const group of request.groups ?? []) {
    const key = JSON.stringify([group.groupWorkspaceId, group.groupId, group.sourceSeriesId]);
    const source = sources.get(group.sourceSeriesId);
    if (
      groupKeys.has(key) ||
      group.groupWorkspaceId.trim() === '' ||
      group.groupId.trim() === '' ||
      (source?.type !== 'line-items-aggregated-yearly' &&
        source?.type !== 'commitments-analytics') ||
      group.memberTerritoryCodes.length === 0 ||
      group.memberTerritoryCodes.length > 4096 ||
      new Set(group.memberTerritoryCodes).size !== group.memberTerritoryCodes.length
    )
      return err(
        createInvalidInputError(
          'Map groups require unique members and an existing financial source'
        )
      );
    groupKeys.add(key);
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

  const receivedGroups = providerResult.value.groupValues ?? [];
  const receivedKeys = new Set(
    receivedGroups.map((group) =>
      JSON.stringify([group.groupWorkspaceId, group.groupId, group.sourceSeriesId])
    )
  );
  if (
    receivedGroups.length !== groupKeys.size ||
    receivedKeys.size !== groupKeys.size ||
    [...receivedKeys].some((key) => !groupKeys.has(key))
  )
    return err(createProviderError('Map provider omitted or duplicated requested group values'));

  for (const group of receivedGroups) {
    const expected = request.groups?.find(
      (value) =>
        value.groupWorkspaceId === group.groupWorkspaceId &&
        value.groupId === group.groupId &&
        value.sourceSeriesId === group.sourceSeriesId
    );
    const expectedMembers = new Set(expected?.memberTerritoryCodes);
    if (
      expected?.memberTerritoryCodes.length !== group.memberTerritoryCodes.length ||
      new Set(group.memberTerritoryCodes).size !== expected.memberTerritoryCodes.length ||
      group.memberTerritoryCodes.some((code) => !expectedMembers.has(code))
    )
      return err(createProviderError('Map provider returned mismatched group membership'));
    if (
      group.value !== null &&
      (!DECIMAL_TEXT.test(group.value) || !new Decimal(group.value).isFinite())
    )
      return err(createProviderError('Map provider returned an invalid group decimal'));
  }

  const seriesOrder = request.series.map((series) => series.id.trim());
  const vectorBySeriesId = new Map<string, NormalizedVector>();
  const sirutaUniverse = normalizeSirutaUniverse(providerResult.value.sirutaUniverse);
  const requestedSeriesIds = new Set(seriesOrder);

  for (const vector of providerResult.value.vectors) {
    const seriesId = vector.seriesId.trim();
    if (!requestedSeriesIds.has(seriesId) || vectorBySeriesId.has(seriesId)) {
      return err(
        createProviderError('Map series provider returned unexpected or duplicate series')
      );
    }
    const normalized = normalizeVector(vector);
    if (normalized.isErr()) return err(normalized.error);
    vectorBySeriesId.set(seriesId, normalized.value);
  }
  if (vectorBySeriesId.size !== seriesOrder.length) {
    return err(createProviderError('Map series provider omitted a requested series'));
  }

  const rows: GroupedSeriesMatrixRow[] = sirutaUniverse.map((sirutaCode) => ({
    sirutaCode,
    valuesBySeriesId: new Map(
      seriesOrder.map((seriesId) => [
        seriesId,
        vectorBySeriesId.get(seriesId)?.valuesBySirutaCode.get(sirutaCode),
      ])
    ),
  }));

  const manifestSeries = seriesOrder.map((seriesId) => {
    const unit = vectorBySeriesId.get(seriesId)?.unit;
    return {
      series_id: seriesId,
      ...(unit !== undefined ? { unit } : {}),
      defined_value_count: rows.filter((row) => row.valuesBySeriesId.get(seriesId) !== undefined)
        .length,
    };
  });

  return ok({
    manifest: {
      generated_at: (deps.now ?? (() => new Date()))().toISOString(),
      format: 'wide_matrix_v1',
      granularity: request.granularity,
      series: manifestSeries,
    },
    seriesOrder,
    rows,
    warnings: providerResult.value.warnings,
    ...(request.groups === undefined ? {} : { groupValues: receivedGroups }),
  });
}
