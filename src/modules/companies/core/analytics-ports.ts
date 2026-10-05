/**
 * Companies analytics — ports.
 *
 * Three narrow ports, so the usecases stay pure and engine-neutral:
 *  - the release source (PostgreSQL `companies_analytics.*` publication rows);
 *  - the engine (ClickHouse `companies_analytics.company_r<N>` /
 *    `company_year_r<N>`): keys and numbers only, never text;
 *  - the label source (PostgreSQL current names and code labels, batched per
 *    answer after aggregation).
 *
 * Every count, sum and value crosses these ports as an exact decimal string.
 */

import type { CompanyAnalysisReleaseRow } from './analytics-release.js';
import type {
  CompanyAnalysisCohortMode,
  CompanyAnalysisDimension,
  CompanyAnalysisDirection,
  CompanyAnalysisMetric,
  CompanyAnalysisRecordSort,
  CompanyAnalysisScope,
  CompanyAnalysisStatus,
} from './analytics-types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * The current ONRC publication envelope (`companies_v2.onrc_current_publication`
 * with its `onrc_published_editions` row), rendered exactly as the source pin
 * is written: ids/epochs as text, the source date as `YYYY-MM-DD` (or the
 * `out-of-range` sentinel, which never equals a pin).
 */
export interface CurrentOnrcPublication {
  readonly publicationState: string;
  /** The edition is listed among the published editions. */
  readonly listed: boolean;
  readonly editionId: string | null;
  readonly publicationEpoch: string | null;
  readonly sourceSnapshotId: string | null;
  readonly sourcePublishedAt: string | null;
  readonly interpretationVersion: string | null;
  readonly dimensionPolicyVersion: string | null;
  readonly privacyPolicyVersion: string | null;
}

/**
 * One reading of `companies_analytics.privacy_state` and of the current ONRC
 * publication, taken by ONE fresh statement. The guard trusts it only from
 * the primary (`inRecovery` false) under READ COMMITTED; a fixed snapshot
 * could hide a withdrawal or a source event.
 */
export interface AnalyticsCurrentState {
  readonly epoch: string;
  readonly inRecovery: boolean;
  readonly isolation: string;
  readonly onrc: CurrentOnrcPublication;
}

export interface CompanyAnalysisReleaseSource {
  /** The terminal publication (`active_release`), or null when nothing is published. */
  activeRelease(): Promise<Result<CompanyAnalysisReleaseRow | null, ApiError>>;
  /** A verified release that appears in the publication chain, or null. */
  publishedRelease(
    releaseNumber: number
  ): Promise<Result<CompanyAnalysisReleaseRow | null, ApiError>>;
  /** The current privacy epoch and ONRC publication: a fresh, uncached statement on every call. */
  currentState(): Promise<Result<AnalyticsCurrentState, ApiError>>;
}

/** One metric over a set of statements: the reported sum and every status count. */
export interface MetricAggregateRow {
  /** Exact sum of REPORTED values (money or headcount text); null when none. */
  readonly sum: string | null;
  readonly statuses: Readonly<Record<CompanyAnalysisStatus, string>>;
}

export interface FilerAggregateRow {
  /** Statements (company-years) matched. */
  readonly filers: string;
  readonly metrics: ReadonlyMap<CompanyAnalysisMetric, MetricAggregateRow>;
}

/**
 * A dimension value as raw parts (see the engine's per-dimension columns):
 * COUNTY / UAT / OBSERVED_STATUS (consensus value, basis); MAIN_CAEN (basis,
 * revision, code); one part for every other dimension. EMPLOYEE_SIZE parts
 * are the stored band, or null without a statement.
 */
export type DimensionParts = readonly (string | null)[];

export interface BreakdownPopulationRow {
  readonly parts: DimensionParts;
  readonly companies: string;
}

export interface BreakdownFilerRow {
  readonly parts: DimensionParts;
  readonly filers: string;
  /** Absent when the breakdown carries no metric. */
  readonly metric: MetricAggregateRow | null;
}

export interface BreakdownRows {
  readonly population: readonly BreakdownPopulationRow[];
  readonly filers: readonly BreakdownFilerRow[];
}

export interface SeriesYearRow {
  readonly fiscalYear: number;
  /** Statements matching the scope's company keys and selected-year filters in that year. */
  readonly statements: string;
  readonly metric: MetricAggregateRow;
}

export interface SeriesRows {
  /**
   * EACH_YEAR: the `company_r` count for the company keys (null when the scope
   * requires a statement, where the population IS the year's filers).
   * REFERENCE_YEAR: the cohort size.
   */
  readonly base: string | null;
  readonly years: readonly SeriesYearRow[];
}

/** The keyset position after which the next page starts. */
export interface RecordsAfter {
  /** The sort value of the last row (null in the NULLS LAST tail; unused for CUI sort). */
  readonly value: string | null;
  readonly cui: string;
}

export interface RecordsRequest {
  readonly sort: CompanyAnalysisRecordSort;
  readonly sortMetric: CompanyAnalysisMetric | null;
  readonly direction: CompanyAnalysisDirection;
  readonly after: RecordsAfter | null;
  /** Rows to fetch (page size + 1 to detect a next page). */
  readonly limit: number;
  /** Metrics whose value/status each row carries (always includes sortMetric). */
  readonly metrics: readonly CompanyAnalysisMetric[];
}

export interface RecordValueRow {
  readonly value: string | null;
  readonly status: string | null;
}

export interface RecordRow {
  readonly cui: string;
  readonly legalForm: string;
  readonly legalFormBasis: string;
  readonly statusCode: string | null;
  readonly statusBasis: string;
  readonly statusCoverage: string;
  readonly caenCoverage: string;
  readonly countyCode: string | null;
  readonly countyBasis: string;
  readonly uatSiruta: string | null;
  readonly uatBasis: string;
  /** `onrc_recorded_year` as text, or null. */
  readonly recordedYear: string | null;
  /** `onrc_recorded_date`: exact `YYYY-MM-DD` text, or null. */
  readonly recordedDate: string | null;
  readonly recordedDateBasis: string;
  /** 'YES' | 'NO', or null for an unknown observation. */
  readonly vatPayer: string | null;
  readonly fiscallyInactive: string | null;
  readonly caenBasis: string;
  readonly caenRevision: string | null;
  readonly caenCode: string | null;
  readonly filed: boolean;
  readonly sizeBand: string | null;
  readonly values: ReadonlyMap<CompanyAnalysisMetric, RecordValueRow>;
}

/**
 * The analytical engine over ONE immutable release. `releaseNumber` is the
 * validated id; the engine builds its table names from it and nothing else.
 */
export interface CompanyAnalysisEngine {
  /** Both release tables exist and are readable. */
  tablesAvailable(releaseNumber: number): Promise<Result<boolean, ApiError>>;
  /** Companies in the scope's population for its fiscal year. */
  countPopulation(
    releaseNumber: number,
    scope: CompanyAnalysisScope
  ): Promise<Result<string, ApiError>>;
  /** The scope's selected-year statements with the requested metrics. */
  aggregateFilers(
    releaseNumber: number,
    scope: CompanyAnalysisScope,
    metrics: readonly CompanyAnalysisMetric[]
  ): Promise<Result<FilerAggregateRow, ApiError>>;
  /** EVERY group of the dimension (no top-N): ranking and `other` are exact in core. */
  breakdown(
    releaseNumber: number,
    scope: CompanyAnalysisScope,
    dimension: CompanyAnalysisDimension,
    metric: CompanyAnalysisMetric | null
  ): Promise<Result<BreakdownRows, ApiError>>;
  series(
    releaseNumber: number,
    scope: CompanyAnalysisScope,
    metric: CompanyAnalysisMetric,
    fromYear: number,
    toYear: number,
    mode: CompanyAnalysisCohortMode
  ): Promise<Result<SeriesRows, ApiError>>;
  records(
    releaseNumber: number,
    scope: CompanyAnalysisScope,
    request: RecordsRequest
  ): Promise<Result<readonly RecordRow[], ApiError>>;
}

export interface CaenLabelKey {
  readonly revision: string;
  readonly code: string;
}

/**
 * Current PostgreSQL presentation data, read in fresh bounded batches after
 * aggregation. Status labels are not here: they come from the API's static
 * nomenclature (no source-observed label is read).
 */
export interface CompanyAnalysisLabelSource {
  /** Current public core-directory company names by CUI (absent = not publicly named). */
  companyNames(cuis: readonly string[]): Promise<Result<ReadonlyMap<string, string>, ApiError>>;
  countyLabels(codes: readonly string[]): Promise<Result<ReadonlyMap<string, string>, ApiError>>;
  uatLabels(sirutas: readonly string[]): Promise<Result<ReadonlyMap<string, string>, ApiError>>;
  /** Keyed `${revision}:${code}`; only revision-known codes are ever asked. */
  caenLabels(keys: readonly CaenLabelKey[]): Promise<Result<ReadonlyMap<string, string>, ApiError>>;
}
