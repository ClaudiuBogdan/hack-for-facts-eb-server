/**
 * INS native module — the repository port (pure interface; the shell implements
 * it over Chronos `ins.*`, tests implement it in memory).
 *
 * Two families, deliberately split: CATALOG reads (small tables, may be cached
 * long) and FACT reads (the partitioned observations, always fully resolved to
 * physical slot predicates before they reach the repository). The usecases do
 * every public-identifier resolution; the repository never sees a label, a
 * `TOTAL` alias or a territory code on the fact path.
 */

import type {
  InsContext,
  InsContextFilter,
  InsDatasetFilter,
  InsDatasetView,
  InsDimensionView,
  InsFactQuery,
  InsMemberView,
  InsObservationView,
  InsPage,
  InsPeriodView,
  InsPeriodicity,
  InsSeriesSpec,
  InsTerritoryFilter,
  InsTerritoryLevel,
  InsTerritoryNode,
  InsUnitView,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** A RESOLVED member bound to a spine node in one dataset dimension. */
export interface InsTerritoryBinding {
  readonly datasetCode: string;
  readonly dimIndex: number;
  readonly slotIndex: number;
  readonly nomItemId: number;
  readonly territoryId: number;
  readonly territoryLevel: InsTerritoryLevel;
}

/**
 * A territorial dimension of a dataset: the spine levels its RESOLVED members
 * bind to (computed over the WHOLE dimension, never inferred from a TOTAL row's
 * nullable level) and its TOTAL member, if any.
 */
export interface InsTerritoryDimension {
  readonly datasetCode: string;
  readonly dimIndex: number;
  readonly slotIndex: number;
  readonly levels: readonly InsTerritoryLevel[];
  readonly totalNomItemId: number | null;
}

/** The default pin for one non-time dimension of a dataset (ins.default_series). */
export interface InsDefaultPin {
  readonly datasetCode: string;
  readonly dimIndex: number;
  readonly nomItemId: number;
  readonly policy: string;
}

/** Period predicates for a batched series read (same semantics as InsFactQuery). */
export interface InsSeriesPeriod {
  readonly periodicities?: readonly InsPeriodicity[];
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodRanges?: readonly { readonly start: string; readonly end: string }[];
}

/** A fact row returned from a batched series read, keyed by the series it answers. */
export interface InsSeriesRow {
  readonly seriesKey: string;
  readonly observation: InsObservationView;
}

export interface InsCatalogRepo {
  listDatasets(
    filter: InsDatasetFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsPage<InsDatasetView>, ApiError>>;
  getDataset(code: string): Promise<Result<InsDatasetView | null, ApiError>>;
  /** Datasets by code, in the requested order; unknown codes are omitted. */
  getDatasets(codes: readonly string[]): Promise<Result<readonly InsDatasetView[], ApiError>>;
  listDimensions(datasetCode: string): Promise<Result<readonly InsDimensionView[], ApiError>>;
  listMembers(
    datasetCode: string,
    dimIndex: number,
    search: string | undefined,
    limit: number,
    offset: number
  ): Promise<Result<InsPage<InsMemberView>, ApiError>>;
  /** Members by id for one dataset (any dimension), for hydration. */
  membersByIds(
    datasetCode: string,
    nomItemIds: readonly number[]
  ): Promise<Result<readonly InsMemberView[], ApiError>>;
  listUnits(datasetCode: string): Promise<Result<readonly InsUnitView[], ApiError>>;
  /**
   * Periods by their TEMPO label (`Anul 2019`, `Trimestrul I 2010`, …): the time
   * members of every dataset map to `ins.periods` by exact label (73,902/73,902
   * measured 2026-09-02), so a time-dimension value carries its period without
   * a fact scan.
   */
  periodsByLabels(labels: readonly string[]): Promise<Result<readonly InsPeriodView[], ApiError>>;
  listContexts(
    filter: InsContextFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsPage<InsContext>, ApiError>>;
  listTerritories(
    filter: InsTerritoryFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsPage<InsTerritoryNode>, ApiError>>;
  /** Nodes by public code (any level unless `level` narrows it); unknown codes omitted. */
  territoriesByCodes(
    codes: readonly string[],
    levels?: readonly InsTerritoryLevel[]
  ): Promise<Result<readonly InsTerritoryNode[], ApiError>>;
  territoriesBySiruta(
    sirutaCodes: readonly string[]
  ): Promise<Result<readonly InsTerritoryNode[], ApiError>>;
  /** A node and its ancestors up to NATIONAL, deepest first. */
  ancestorsOf(territoryId: number): Promise<Result<readonly InsTerritoryNode[], ApiError>>;
  /** The dataset's territorial dimensions (levels present, TOTAL member). */
  territoryDimensions(
    datasetCode: string
  ): Promise<Result<readonly InsTerritoryDimension[], ApiError>>;
  /** The RESOLVED bindings of the dataset's territorial dimensions onto the given nodes. */
  territoryBindings(
    datasetCode: string,
    territoryIds: readonly number[]
  ): Promise<Result<readonly InsTerritoryBinding[], ApiError>>;
  /** The TOTAL member of a dimension, if it has exactly one. */
  totalMember(datasetCode: string, dimIndex: number): Promise<Result<number | null, ApiError>>;
  defaultPins(datasetCodes: readonly string[]): Promise<Result<readonly InsDefaultPin[], ApiError>>;
  /** Dataset codes whose territorial dimension binds at the given level. */
  datasetsWithLevel(level: InsTerritoryLevel): Promise<Result<readonly string[], ApiError>>;
}

export interface InsFactRepo {
  /** Facts-first page read (limit + 1 inside), hydrated from the catalogs. */
  listObservations(query: InsFactQuery): Promise<Result<InsPage<InsObservationView>, ApiError>>;
  /**
   * For each fully pinned series, its most recent `perSeries` observations (one
   * batched statement). `period` narrows INSIDE the statement, so a requested
   * period older than the newest `perSeries` rows is still found.
   */
  latestForSeries(
    series: readonly InsSeriesSpec[],
    perSeries: number,
    period?: InsSeriesPeriod
  ): Promise<Result<readonly InsSeriesRow[], ApiError>>;
}

export interface InsRepo extends InsCatalogRepo, InsFactRepo {
  /**
   * Run `fn` against a repository bound to ONE repeatable-read, read-only
   * snapshot, so every catalog read and the fact read of a request see the same
   * publication moment (a promotion between two calls can otherwise combine old
   * pins with new facts).
   */
  withSnapshot<T>(
    fn: (repo: InsRepo) => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>>;
}
