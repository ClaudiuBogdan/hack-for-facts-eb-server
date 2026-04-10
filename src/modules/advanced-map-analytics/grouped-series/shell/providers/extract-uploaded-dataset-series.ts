import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import {
  type AdvancedMapDatasetDetail,
  type AdvancedMapDatasetRow,
} from '@/modules/advanced-map-datasets/index.js';

import { type GroupedSeriesError } from '../../core/errors.js';

import type { GroupedSeriesWarning } from '../../core/types.js';

export interface UploadedDatasetSeriesExtractionOutput {
  valuesBySirutaCode: Map<string, number | undefined>;
  unit?: string;
  warnings: GroupedSeriesWarning[];
}

function readUploadedDatasetRowNumericValue(
  row: AdvancedMapDatasetRow
): Result<number | undefined, GroupedSeriesError> {
  if (row.valueNumber === null) {
    return ok(undefined);
  }

  try {
    const decimalValue = new Decimal(row.valueNumber);
    const numericValue = decimalValue.toNumber();
    if (Number.isFinite(numericValue) && new Decimal(numericValue.toString()).eq(decimalValue)) {
      return ok(numericValue);
    }
  } catch {
    return ok(undefined);
  }

  return ok(undefined);
}

export function validateUploadedDatasetSeriesCompatibility(
  dataset: AdvancedMapDatasetDetail,
  sirutaUniverse?: Set<string>
): Result<void, GroupedSeriesError> {
  for (const row of dataset.rows) {
    if (sirutaUniverse !== undefined && !sirutaUniverse.has(row.sirutaCode)) {
      continue;
    }

    const numericValueResult = readUploadedDatasetRowNumericValue(row);
    if (numericValueResult.isErr()) {
      return err(numericValueResult.error);
    }
  }

  return ok(undefined);
}

export function extractUploadedDatasetSeriesVector(
  dataset: AdvancedMapDatasetDetail,
  sirutaUniverse: Set<string>
): Promise<Result<UploadedDatasetSeriesExtractionOutput, GroupedSeriesError>> {
  const compatibilityResult = validateUploadedDatasetSeriesCompatibility(dataset, sirutaUniverse);
  if (compatibilityResult.isErr()) {
    return Promise.resolve(err(compatibilityResult.error));
  }

  const valuesBySirutaCode = new Map<string, number | undefined>();

  for (const row of dataset.rows) {
    if (!sirutaUniverse.has(row.sirutaCode)) {
      continue;
    }

    const numericValueResult = readUploadedDatasetRowNumericValue(row);
    if (numericValueResult.isErr()) {
      return Promise.resolve(err(numericValueResult.error));
    }

    if (numericValueResult.value !== undefined) {
      valuesBySirutaCode.set(row.sirutaCode, numericValueResult.value);
      continue;
    }
  }

  return Promise.resolve(
    ok({
      valuesBySirutaCode,
      warnings: [],
    })
  );
}
