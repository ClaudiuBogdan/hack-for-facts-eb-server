/**
 * Budget module — repository ports (plan §3). Two repos:
 *  - `BudgetRepo`        — facts (fact path), summaries/rankings/timeseries (MV
 *                          path), aggregates, reports, dimensions, official,
 *                          contributor support, freshness.
 *  - `BudgetDiscoveryRepo` — name→value resolution (plan §7.4/§7.5).
 *
 * Every method returns `Result<T, ApiError>` (neverthrow). Repos receive the typed
 * Kysely `ProdDatabase` instance and touch ONLY `budget.*` + the kernel `core.*`
 * (read). No writes. Each fact method enforces the §0.3 pruning gate; each MV
 * method follows §0.4 (no `account_category` predicate on MV reads).
 */

import type { AccountCategory, ExecutionReportType } from './constants.js';
import type {
  AggregatedBudgetRow,
  ApprovedBudgetFact,
  BudgetAsOf,
  BudgetClassification,
  BudgetCommitmentFactQuery,
  BudgetEntitySummary,
  BudgetFactQuery,
  BudgetFundingSource,
  BudgetProfileSlice,
  BudgetReport,
  BudgetResolveDim,
  BudgetSector,
  BudgetSeriesPoint,
  BudgetVsExecutionRow,
  ClassificationAggregateQuery,
  CommitmentEntitySummary,
  CommitmentLineItem,
  CommitmentRankingQuery,
  CommitmentSummaryQuery,
  CommitmentTimeseriesQuery,
  CountyHeatmapPoint,
  EntityRankingQuery,
  ExecutionLineItem,
  GatedOffsetPage,
  HeatmapQuery,
  RankedCommitmentEntity,
  RankedEntity,
  ResolveMatch,
  SummaryQuery,
  TimeseriesQuery,
} from './types.js';
import type { ApiError, CursorPage, FilterInput, SourcePresence } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

export interface BudgetRepo {
  // ── line-item facts (fact path; §0.3 pruning triple MANDATORY) ──
  listExecutionLineItems(q: BudgetFactQuery): Promise<Result<CursorPage<ExecutionLineItem>, ApiError>>;
  getExecutionLineItem(q: {
    year: number;
    reportType: ExecutionReportType;
    accountCategory: AccountCategory;
    id: string;
  }): Promise<Result<ExecutionLineItem | null, ApiError>>;
  listCommitmentLineItems(
    q: BudgetCommitmentFactQuery
  ): Promise<Result<CursorPage<CommitmentLineItem>, ApiError>>;

  // ── entity/period summaries (MV path; index-only, §0.4) ──
  getEntitySummary(cui: string, q: SummaryQuery): Promise<Result<readonly BudgetEntitySummary[], ApiError>>;
  getCommitmentSummary(
    cui: string,
    q: CommitmentSummaryQuery
  ): Promise<Result<readonly CommitmentEntitySummary[], ApiError>>;
  executionTimeseries(q: TimeseriesQuery): Promise<Result<readonly BudgetSeriesPoint[], ApiError>>;
  commitmentTimeseries(q: CommitmentTimeseriesQuery): Promise<Result<readonly BudgetSeriesPoint[], ApiError>>;

  // ── rankings (MV path + normalization factors, §3.4; bounded top-N) ──
  rankEntities(q: EntityRankingQuery): Promise<Result<readonly RankedEntity[], ApiError>>;
  rankCommitmentEntities(
    q: CommitmentRankingQuery
  ): Promise<Result<readonly RankedCommitmentEntity[], ApiError>>;

  // ── classification aggregate (fact path; ONE pruned leaf) ──
  aggregateByClassification(
    q: ClassificationAggregateQuery
  ): Promise<Result<readonly AggregatedBudgetRow[], ApiError>>;

  // ── geo heatmap (MV → county rollup, §3.4) ──
  countyHeatmap(q: HeatmapQuery): Promise<Result<readonly CountyHeatmapPoint[], ApiError>>;

  // ── reports (metadata; bounded by entity/year/report_type indexes) ──
  listReports(q: {
    filter: FilterInput;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<BudgetReport>, ApiError>>;
  getReport(reportId: string): Promise<Result<BudgetReport | null, ApiError>>;

  // ── dimensions (small reference tables; functional/economic are capability-gated:
  //    the classification catalogs are empty in prod — names live on the facts) ──
  listFunctionalClassifications(q: {
    search?: string;
    codes?: readonly string[];
    limit: number;
  }): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>>;
  listEconomicClassifications(q: {
    search?: string;
    codes?: readonly string[];
    limit: number;
  }): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>>;
  listBudgetSectors(q: { search?: string; ids?: readonly number[] }): Promise<Result<readonly BudgetSector[], ApiError>>;
  listFundingSources(q: { search?: string; ids?: readonly number[] }): Promise<Result<readonly BudgetFundingSource[], ApiError>>;

  // ── budget-official (un-partitioned; capability-gated on row presence) ──
  listApprovedBudgetFacts(q: {
    filter: FilterInput;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<ApprovedBudgetFact>, ApiError>>;
  budgetVsExecution(q: {
    budgetYear?: number;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<BudgetVsExecutionRow>, ApiError>>;

  // ── contributor support (§4.1) ──
  presenceFor(cui: string): Promise<Result<SourcePresence | null, ApiError>>;
  profileSlice(cui: string): Promise<Result<BudgetProfileSlice | null, ApiError>>;

  // ── freshness ──
  asOf(): Promise<Result<BudgetAsOf, ApiError>>;
}

/**
 * Name→value resolution (plan §7.4/§7.5). `entity`/`territory` use the kernel
 * identity/territory hubs (pg_trgm + SIRUTA); `functional`/`economic` are
 * capability-gated (the catalog tables are empty in prod — see DESIGN): they
 * resolve a CODE prefix against a bounded distinct scan and return a caveat for
 * open-ended name queries.
 */
export interface BudgetDiscoveryRepo {
  resolve(dim: BudgetResolveDim, q: string, limit: number): Promise<Result<readonly ResolveMatch[], ApiError>>;
}
