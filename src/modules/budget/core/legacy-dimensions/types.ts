/**
 * Legacy dimension roots on the kernel (docs/server-redesign/13 §4 "dimension
 * usecases"): `budgetSectors`, `fundingSources`, `functionalClassifications`,
 * `economicClassifications` — offset pages with an exact `totalCount`, the
 * legacy contract the client documents read.
 *
 * Constants are the legacy modules' values (budget-sector/core/types.ts,
 * funding-sources/core/types.ts, classification/core/types.ts) except the
 * classification maximum: legacy clamped to 1000 and silently truncated the
 * client's "all classifications" documents (limit 10000) below the catalog size
 * (1,117 functional / 757 economic on Chronos, 2026-09-02); the user lifted it
 * to 2000 (task overview decision S1-10, a fixed-bug delta).
 */

export const LEGACY_SECTORS_DEFAULT_LIMIT = 20;
export const LEGACY_SECTORS_MAX_LIMIT = 200;
export const LEGACY_FUNDING_SOURCES_DEFAULT_LIMIT = 10;
export const LEGACY_FUNDING_SOURCES_MAX_LIMIT = 200;
export const LEGACY_CLASSIFICATIONS_DEFAULT_LIMIT = 100;
/** Measured catalog size + headroom (re-validate if the catalog grows past 2000). */
export const LEGACY_CLASSIFICATIONS_MAX_LIMIT = 2000;
/** pg_trgm `similarity(description, term) > 0.1`, the legacy fuzzy-match threshold. */
export const LEGACY_SIMILARITY_THRESHOLD = 0.1;

export type LegacyClassificationKind = 'functional' | 'economic';

export interface LegacyPageInfo {
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface LegacyPage<T> {
  readonly nodes: readonly T[];
  readonly pageInfo: LegacyPageInfo;
}

/** Legacy `BudgetSector` node: `sector_id: ID!` is serialized as a string. */
export interface LegacySector {
  readonly sector_id: string;
  readonly sector_description: string;
}

/** Legacy `FundingSource` node (`executionLineItems` is a field resolver). */
export interface LegacyFundingSource {
  readonly source_id: string;
  readonly source_description: string;
}

/** One shape for both catalogs; the resolver renames to functional_/economic_. */
export interface LegacyClassification {
  readonly code: string;
  readonly name: string;
}

export interface LegacyDimensionPageInput {
  readonly search?: string | null | undefined;
  /** `[ID!]` values as the client sends them (strings); validated by the usecase. */
  readonly ids?: readonly string[] | null | undefined;
  readonly limit?: number | null | undefined;
  readonly offset?: number | null | undefined;
}

export interface LegacyClassificationPageInput {
  readonly search?: string | null | undefined;
  readonly codes?: readonly string[] | null | undefined;
  readonly limit?: number | null | undefined;
  readonly offset?: number | null | undefined;
}
