/**
 * Port interfaces for INS module.
 */

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
