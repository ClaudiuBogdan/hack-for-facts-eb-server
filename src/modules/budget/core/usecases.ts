/**
 * Budget module — usecases (plan §4). Framework-free, over the ports. Thin:
 * GraphQL + MCP call the SAME usecase. `getEntityBudget`/`profileSlice` is the
 * single source of truth for the entity rollup — the contributor's `profileSlice`,
 * the GraphQL `Entity.budget` resolver, and the MCP snapshot all go through it
 * (§14.7 contributor parity).
 */

import type { AccountCategory, ExecutionReportType } from './constants.js';
import type { BudgetDiscoveryRepo, BudgetRepo } from './ports.js';
import type {
  AggregatedBudgetRow,
  AggregateTimeseriesQuery,
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
  EntityRankingPageQuery,
  ExecutionLineItem,
  GatedOffsetPage,
  HeatmapQuery,
  RankedCommitmentEntity,
  RankedEntity,
  RankedEntityPage,
  ResolveMatch,
  SummaryQuery,
  TimeseriesQuery,
  UatHeatmapPoint,
} from './types.js';
import type { ApiError, CursorPage, FilterInput } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

// ── facts ─────────────────────────────────────────────────────────────────────

export const listExecutionLineItems = (
  repo: BudgetRepo,
  q: BudgetFactQuery
): Promise<Result<CursorPage<ExecutionLineItem>, ApiError>> => repo.listExecutionLineItems(q);

export const getExecutionLineItem = (
  repo: BudgetRepo,
  q: { year: number; reportType: ExecutionReportType; accountCategory: AccountCategory; id: string }
): Promise<Result<ExecutionLineItem | null, ApiError>> => repo.getExecutionLineItem(q);

export const listCommitmentLineItems = (
  repo: BudgetRepo,
  q: BudgetCommitmentFactQuery
): Promise<Result<CursorPage<CommitmentLineItem>, ApiError>> => repo.listCommitmentLineItems(q);

// ── summaries (MV path) ───────────────────────────────────────────────────────

export const getEntityBudget = (
  repo: BudgetRepo,
  cui: string,
  q: SummaryQuery
): Promise<Result<readonly BudgetEntitySummary[], ApiError>> => repo.getEntitySummary(cui, q);

export const getEntityCommitments = (
  repo: BudgetRepo,
  cui: string,
  q: CommitmentSummaryQuery
): Promise<Result<readonly CommitmentEntitySummary[], ApiError>> =>
  repo.getCommitmentSummary(cui, q);

export const budgetTimeseries = (
  repo: BudgetRepo,
  q: TimeseriesQuery
): Promise<Result<readonly BudgetSeriesPoint[], ApiError>> => repo.executionTimeseries(q);

export const aggregateTimeseries = (
  repo: BudgetRepo,
  q: AggregateTimeseriesQuery
): Promise<Result<readonly BudgetSeriesPoint[], ApiError>> => repo.aggregateTimeseries(q);

export const commitmentTimeseries = (
  repo: BudgetRepo,
  q: CommitmentTimeseriesQuery
): Promise<Result<readonly BudgetSeriesPoint[], ApiError>> => repo.commitmentTimeseries(q);

// ── rankings ──────────────────────────────────────────────────────────────────

export const rankEntities = (
  repo: BudgetRepo,
  q: EntityRankingQuery
): Promise<Result<readonly RankedEntity[], ApiError>> => repo.rankEntities(q);

export const rankEntitiesPage = (
  repo: BudgetRepo,
  q: EntityRankingPageQuery
): Promise<Result<RankedEntityPage, ApiError>> => repo.rankEntitiesPage(q);

export const rankCommitmentEntities = (
  repo: BudgetRepo,
  q: CommitmentRankingQuery
): Promise<Result<readonly RankedCommitmentEntity[], ApiError>> => repo.rankCommitmentEntities(q);

// ── aggregate + heatmap ───────────────────────────────────────────────────────

export const aggregateByClassification = (
  repo: BudgetRepo,
  q: ClassificationAggregateQuery
): Promise<Result<readonly AggregatedBudgetRow[], ApiError>> => repo.aggregateByClassification(q);

export const uatHeatmap = (
  repo: BudgetRepo,
  q: HeatmapQuery
): Promise<Result<readonly UatHeatmapPoint[], ApiError>> => repo.uatHeatmap(q);

export const countyHeatmap = (
  repo: BudgetRepo,
  q: HeatmapQuery
): Promise<Result<readonly CountyHeatmapPoint[], ApiError>> => repo.countyHeatmap(q);

// ── reports + dimensions ──────────────────────────────────────────────────────

export const listReports = (
  repo: BudgetRepo,
  q: { filter: FilterInput; page: number; pageSize: number }
): Promise<Result<GatedOffsetPage<BudgetReport>, ApiError>> => repo.listReports(q);

export const getReport = (
  repo: BudgetRepo,
  reportId: string
): Promise<Result<BudgetReport | null, ApiError>> => repo.getReport(reportId);

export const listFunctionalClassifications = (
  repo: BudgetRepo,
  q: { search?: string; codes?: readonly string[]; limit: number }
): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> =>
  repo.listFunctionalClassifications(q);

export const listEconomicClassifications = (
  repo: BudgetRepo,
  q: { search?: string; codes?: readonly string[]; limit: number }
): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> =>
  repo.listEconomicClassifications(q);

export const listBudgetSectors = (
  repo: BudgetRepo,
  q: { search?: string; ids?: readonly number[] }
): Promise<Result<readonly BudgetSector[], ApiError>> => repo.listBudgetSectors(q);

export const listFundingSources = (
  repo: BudgetRepo,
  q: { search?: string; ids?: readonly number[] }
): Promise<Result<readonly BudgetFundingSource[], ApiError>> => repo.listFundingSources(q);

// ── budget-official (capability-gated) ────────────────────────────────────────

export const listApprovedBudgetFacts = (
  repo: BudgetRepo,
  q: { filter: FilterInput; page: number; pageSize: number }
): Promise<Result<GatedOffsetPage<ApprovedBudgetFact>, ApiError>> =>
  repo.listApprovedBudgetFacts(q);

export const budgetVsExecution = (
  repo: BudgetRepo,
  q: { budgetYear?: number; page: number; pageSize: number }
): Promise<Result<GatedOffsetPage<BudgetVsExecutionRow>, ApiError>> => repo.budgetVsExecution(q);

// ── contributor support + freshness ───────────────────────────────────────────

export const getBudgetProfileSlice = (
  repo: BudgetRepo,
  cui: string
): Promise<Result<BudgetProfileSlice | null, ApiError>> => repo.profileSlice(cui);

export const budgetAsOf = (repo: BudgetRepo): Promise<Result<BudgetAsOf, ApiError>> => repo.asOf();

// ── discovery ─────────────────────────────────────────────────────────────────

export const resolveBudgetFilter = (
  repo: BudgetDiscoveryRepo,
  dim: BudgetResolveDim,
  q: string,
  limit: number
): Promise<Result<readonly ResolveMatch[], ApiError>> => repo.resolve(dim, q, limit);
