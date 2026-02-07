/**
 * List INS dimension values by dataset code + dimension index.
 */

import { err, ok, type Result } from 'neverthrow';

import { listInsDimensionValues } from './list-ins-dimension-values.js';

import type { InsError } from '../errors.js';
import type { InsRepository } from '../ports.js';
import type { InsDimensionValueConnection, InsDimensionValueFilter } from '../types.js';

export interface ListInsDatasetDimensionValuesDeps {
  insRepo: InsRepository;
}

export interface ListInsDatasetDimensionValuesInput {
  dataset_code: string;
  dimension_index: number;
  filter: InsDimensionValueFilter;
  limit: number;
  offset: number;
}

const EMPTY_DIMENSION_VALUE_CONNECTION: InsDimensionValueConnection = {
  nodes: [],
  pageInfo: {
    totalCount: 0,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};

export const listInsDatasetDimensionValues = async (
  deps: ListInsDatasetDimensionValuesDeps,
  input: ListInsDatasetDimensionValuesInput
): Promise<Result<InsDimensionValueConnection, InsError>> => {
  const normalizedDatasetCode = input.dataset_code.trim().toUpperCase();
  if (normalizedDatasetCode === '') {
    return ok(EMPTY_DIMENSION_VALUE_CONNECTION);
  }

  const datasetResult = await deps.insRepo.getDatasetByCode(normalizedDatasetCode);
  if (datasetResult.isErr()) {
    return err(datasetResult.error);
  }

  const dataset = datasetResult.value;
  if (dataset === null) {
    return ok(EMPTY_DIMENSION_VALUE_CONNECTION);
  }

  const dimensionsResult = await deps.insRepo.listDimensions(dataset.id);
  if (dimensionsResult.isErr()) {
    return err(dimensionsResult.error);
  }

  const dimensionExists = dimensionsResult.value.some(
    (dimension) => dimension.index === input.dimension_index
  );
  if (!dimensionExists) {
    return ok(EMPTY_DIMENSION_VALUE_CONNECTION);
  }

  return listInsDimensionValues(
    { insRepo: deps.insRepo },
    {
      matrix_id: dataset.id,
      dim_index: input.dimension_index,
      filter: input.filter,
      limit: input.limit,
      offset: input.offset,
    }
  );
};
