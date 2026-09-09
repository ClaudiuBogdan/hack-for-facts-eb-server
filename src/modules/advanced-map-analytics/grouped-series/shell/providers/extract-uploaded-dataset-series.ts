import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import {
  type AdvancedMapDatasetDetail,
  type AdvancedMapDatasetRow,
} from '@/modules/advanced-map-datasets/index.js';

import { type GroupedSeriesError } from '../../core/errors.js';

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
