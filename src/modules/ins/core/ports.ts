/**
 * Port interfaces for INS module.
 */

import type { InsDatasetRequest, InsDatasetRequestInput } from './dataset-requests.js';
import type { InsError } from './errors.js';
import type {
  InsContextConnection,
  InsContextFilter,
  InsDataset,
  InsDatasetConnection,
  InsDatasetFilter,
  InsDimension,
  InsDimensionValueConnection,
  InsDimensionValueFilter,
  InsLatestDatasetValue,
  InsObservation,
  InsObservationConnection,
  InsTerritoryConnection,
  InsTerritoryFilter,
  ListInsLatestDatasetValuesInput,
  ListInsObservationsInput,
} from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// INS Repository
// ─────────────────────────────────────────────────────────────────────────────

export interface InsRepository {
  listDatasets(
    filter: InsDatasetFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsDatasetConnection, InsError>>;

  listContexts(
    filter: InsContextFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsContextConnection, InsError>>;

  listTerritories(
    filter: InsTerritoryFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsTerritoryConnection, InsError>>;

  getDatasetByCode(code: string): Promise<Result<InsDataset | null, InsError>>;

  listDimensions(matrixId: number): Promise<Result<InsDimension[], InsError>>;

  listDimensionValues(
    matrixId: number,
    dimIndex: number,
    filter: InsDimensionValueFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsDimensionValueConnection, InsError>>;

  listObservations(
    input: ListInsObservationsInput
  ): Promise<Result<InsObservationConnection, InsError>>;

  listLatestDatasetValues(
    input: ListInsLatestDatasetValuesInput
  ): Promise<Result<InsLatestDatasetValue[], InsError>>;

  /**
   * List datasets that have UAT-level data, with their observations for a specific territory.
   * Used by insUatDashboard for efficient single-request loading.
   */
  listUatDatasetsWithObservations(
    sirutaCode: string,
    contextCode?: string,
    period?: string
  ): Promise<Result<{ dataset: InsDataset; observations: InsObservation[] }[], InsError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// INS Dataset Request Repository (writes to the server-owned user database)
// ─────────────────────────────────────────────────────────────────────────────

export interface InsDatasetRequestRepository {
  create(input: InsDatasetRequestInput): Promise<Result<InsDatasetRequest, InsError>>;
}

/**
 * Narrow read port so the request usecase can reject codes that are not in the
 * INS catalog, without depending on the whole {@link InsRepository}. Must be
 * backed by the full catalog (`matrices`), not `v_matrices`: requesting a
 * CATALOG_ONLY dataset is the entire point of the endpoint.
 */
export interface InsDatasetCatalogReader {
  datasetExists(code: string): Promise<Result<boolean, InsError>>;
}
