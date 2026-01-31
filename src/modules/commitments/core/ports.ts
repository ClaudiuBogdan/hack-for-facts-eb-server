import type { CommitmentsError } from './errors.js';
import type {
  CommitmentsAggregatedConnection,
  CommitmentsFilter,
  CommitmentsLineItemConnection,
  CommitmentsSummaryConnection,
} from './types.js';
import type { CommitmentsMetric } from '@/common/types/commitments.js';
import type { DataSeries } from '@/common/types/temporal.js';
import type { Decimal } from 'decimal.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Shared Repo Helper Types
// ─────────────────────────────────────────────────────────────────────────────

export type PeriodFactorMap = Map<string, Decimal>;

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface AggregateFilters {
  minAmount?: Decimal;
  maxAmount?: Decimal;
}

// ─────────────────────────────────────────────────────────────────────────────
// commitmentVsExecution Repo Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentExecutionMonthRow {
  year: number;
  month: number;
  commitment_value: Decimal;
  execution_value: Decimal;
}

export interface CommitmentExecutionJoinCounts {
  matched_count: number;
  unmatched_commitment_count: number;
  unmatched_execution_count: number;
}

export interface CommitmentExecutionMonthData {
  rows: CommitmentExecutionMonthRow[];
  counts: CommitmentExecutionJoinCounts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentsRepository {
  listSummary(
    filter: CommitmentsFilter,
    limit: number,
    offset: number
  ): Promise<Result<CommitmentsSummaryConnection, CommitmentsError>>;

  listLineItems(
    filter: CommitmentsFilter,
    limit: number,
    offset: number
  ): Promise<Result<CommitmentsLineItemConnection, CommitmentsError>>;

  getAnalyticsSeries(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric
  ): Promise<Result<DataSeries, CommitmentsError>>;

  getAggregated(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric,
    factorMap: PeriodFactorMap,
    pagination: PaginationParams,
    aggregateFilters?: AggregateFilters
  ): Promise<Result<CommitmentsAggregatedConnection, CommitmentsError>>;

  getCommitmentVsExecutionMonthData(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric
  ): Promise<Result<CommitmentExecutionMonthData, CommitmentsError>>;
}
