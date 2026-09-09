/**
 * Ports of the INS dataset-request feature: the write side lives in the
 * server-owned user database; the catalog check reads the INS catalog.
 */

import type { DatasetRequestError } from './errors.js';
import type { InsDatasetRequest, InsDatasetRequestInput } from './types.js';
import type { Result } from 'neverthrow';

export interface InsDatasetRequestRepository {
  create(input: InsDatasetRequestInput): Promise<Result<InsDatasetRequest, DatasetRequestError>>;
}

/**
 * Narrow read port so the request usecase can reject codes that are not in the
 * INS catalog. Must be backed by the FULL catalog (every `ins.datasets` row,
 * loaded or not): requesting a not-yet-loaded dataset is the entire point of
 * the endpoint.
 */
export interface InsDatasetCatalogReader {
  datasetExists(code: string): Promise<Result<boolean, DatasetRequestError>>;
}
