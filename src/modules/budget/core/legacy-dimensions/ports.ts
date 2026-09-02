/**
 * Data access for the legacy dimension roots — the module gains a usecase and a
 * repo method, never the GraphQL slice (design 13 §3 rule 2: no SQL in the slice).
 */

import type { LegacyClassificationKind } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

export interface LegacyDimensionRows<T> {
  readonly rows: readonly T[];
  /** Exact count of every row matching the same predicate (legacy contract). */
  readonly totalCount: number;
}

export interface LegacySectorRow {
  readonly sectorId: number;
  readonly sectorDescription: string | null;
}

export interface LegacyFundingSourceRow {
  readonly sourceId: number;
  readonly sourceDescription: string | null;
}

export interface LegacyClassificationRow {
  readonly code: string;
  readonly name: string | null;
}

export interface LegacyDimensionQuery {
  readonly search?: string;
  readonly ids?: readonly number[];
  readonly limit: number;
  readonly offset: number;
}

export interface LegacyClassificationQuery {
  readonly search?: string;
  readonly codes?: readonly string[];
  readonly limit: number;
  readonly offset: number;
}

export interface LegacyDimensionRepo {
  /** `budget.budget_sectors`: ilike OR pg_trgm similarity on the description; ordered by id. */
  listSectors(
    q: LegacyDimensionQuery
  ): Promise<Result<LegacyDimensionRows<LegacySectorRow>, ApiError>>;
  /** `budget.v_funding_sources_compat` (phoenix-ordinal ids, the synthetic 0 row excluded). */
  listFundingSources(
    q: LegacyDimensionQuery
  ): Promise<Result<LegacyDimensionRows<LegacyFundingSourceRow>, ApiError>>;
  /** Either catalog: functional = code-prefix for code-like terms, else contains; economic = always contains (both unaccented). */
  listClassifications(
    kind: LegacyClassificationKind,
    q: LegacyClassificationQuery
  ): Promise<Result<LegacyDimensionRows<LegacyClassificationRow>, ApiError>>;
}
