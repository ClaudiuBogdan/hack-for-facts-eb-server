/**
 * Port interfaces for INS module.
 */

import type { InsError } from './errors.js';
import type {
  InsDataset,
  InsDatasetConnection,
  InsDatasetFilter,
  InsDimension,
  InsDimensionValueConnection,
  InsDimensionValueFilter,
  InsObservation,
  InsObservationConnection,
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
