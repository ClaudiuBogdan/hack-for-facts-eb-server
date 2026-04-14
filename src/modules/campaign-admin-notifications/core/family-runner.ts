import type { CampaignAdminNotificationError } from './errors.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationTriggerBulkExecutionResult,
  CampaignNotificationTriggerSource,
  CampaignNotificationFamilySingleExecutionResult,
} from './types.js';
import type { Result } from 'neverthrow';

export interface CampaignNotificationFamilyContext {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly triggerSource: CampaignNotificationTriggerSource;
  readonly actorUserId: string;
  readonly dryRun: boolean;
}

export type CampaignNotificationFamilyPlan<TQueuedPlan> =
  | {
      readonly disposition: 'queue';
      readonly queuedPlan: TQueuedPlan;
    }
  | {
      readonly disposition: 'skip';
      readonly reason: string;
    }
  | {
      readonly disposition: 'delegate';
      readonly reason: string;
      readonly target: string;
    };

export interface CampaignNotificationFamilyCandidatePage<TCandidate, TCursor> {
  readonly items: readonly TCandidate[];
  readonly nextCursor: TCursor | null;
  readonly hasMore: boolean;
}

interface CampaignNotificationFamilyExecutionBase {
  readonly familyId: string;
  readonly createdOutboxIds: readonly string[];
  readonly reusedOutboxIds: readonly string[];
  readonly queuedOutboxIds: readonly string[];
  readonly enqueueFailedOutboxIds: readonly string[];
}

export interface CampaignNotificationFamilyPreparedExecutionOutcome extends CampaignNotificationFamilyExecutionBase {
  readonly kind: 'prepared';
  readonly reason: 'eligible_now';
  readonly dryRun: boolean;
  readonly source: 'created' | 'reused';
}

export interface CampaignNotificationFamilySkippedExecutionOutcome extends CampaignNotificationFamilyExecutionBase {
  readonly kind: 'skipped';
  readonly reason: string;
  readonly category: 'skipped' | 'ineligible' | 'not_replayable' | 'stale';
}

export interface CampaignNotificationFamilyDelegatedExecutionOutcome extends CampaignNotificationFamilyExecutionBase {
  readonly kind: 'delegated';
  readonly reason: string;
  readonly target: string;
}

export type CampaignNotificationFamilyExecutionOutcome =
  | CampaignNotificationFamilyPreparedExecutionOutcome
  | CampaignNotificationFamilySkippedExecutionOutcome
  | CampaignNotificationFamilyDelegatedExecutionOutcome;

export interface CampaignNotificationFamilyDefinition<
  TSingleInput,
  TBulkFilters,
  TCandidate,
  TEnrichment,
  TQueuedPlan,
  TCursor,
> {
  readonly familyId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly templateId: string;
  loadSingleCandidate(
    input: TSingleInput
  ): Promise<Result<TCandidate | null, CampaignAdminNotificationError>>;
  captureBulkWatermark(
    filters: TBulkFilters
  ): Promise<Result<string, CampaignAdminNotificationError>>;
  loadBulkPage(input: {
    readonly filters: TBulkFilters;
    readonly watermark: string;
    readonly pageLimit: number;
    readonly cursor?: TCursor;
  }): Promise<
    Result<
      CampaignNotificationFamilyCandidatePage<TCandidate, TCursor>,
      CampaignAdminNotificationError
    >
  >;
  enrichCandidate(
    candidate: TCandidate
  ): Promise<Result<TEnrichment, CampaignAdminNotificationError>>;
  planCandidate(input: {
    readonly candidate: Readonly<TCandidate>;
    readonly enrichment: Readonly<TEnrichment>;
    readonly context: Omit<CampaignNotificationFamilyContext, 'dryRun'>;
  }): CampaignNotificationFamilyPlan<TQueuedPlan>;
  executePlan(input: {
    readonly candidate: Readonly<TCandidate>;
    readonly enrichment: Readonly<TEnrichment>;
    readonly plan: Readonly<CampaignNotificationFamilyPlan<TQueuedPlan>>;
    readonly context: Readonly<CampaignNotificationFamilyContext>;
  }): Promise<Result<CampaignNotificationFamilyExecutionOutcome, CampaignAdminNotificationError>>;
}

export interface CampaignNotificationFamilyBulkExecutionInput<TBulkFilters> {
  readonly filters: TBulkFilters;
  readonly limit: number;
  readonly context: Readonly<CampaignNotificationFamilyContext>;
}

export interface CampaignNotificationFamilyBulkAggregation {
  readonly kind: 'family_bulk';
  readonly familyId: string;
  readonly dryRun: boolean;
  readonly watermark: string;
  readonly limit: number;
  readonly hasMoreCandidates: boolean;
  readonly candidateCount: number;
  readonly plannedCount: number;
  readonly eligibleCount: number;
  readonly queuedCount: number;
  readonly reusedCount: number;
  readonly skippedCount: number;
  readonly delegatedCount: number;
  readonly ineligibleCount: number;
  readonly notReplayableCount: number;
  readonly staleCount: number;
  readonly enqueueFailedCount: number;
}

export const emptyFamilyBulkAggregation = (input: {
  familyId: string;
  dryRun: boolean;
  watermark: string;
  limit: number;
}): CampaignNotificationFamilyBulkAggregation => ({
  kind: 'family_bulk',
  familyId: input.familyId,
  dryRun: input.dryRun,
  watermark: input.watermark,
  limit: input.limit,
  hasMoreCandidates: false,
  candidateCount: 0,
  plannedCount: 0,
  eligibleCount: 0,
  queuedCount: 0,
  reusedCount: 0,
  skippedCount: 0,
  delegatedCount: 0,
  ineligibleCount: 0,
  notReplayableCount: 0,
  staleCount: 0,
  enqueueFailedCount: 0,
});

export const toFamilySingleExecutionResult = (
  outcome: CampaignNotificationFamilyExecutionOutcome
): CampaignNotificationFamilySingleExecutionResult => {
  if (outcome.kind === 'delegated') {
    return {
      kind: 'family_single',
      familyId: outcome.familyId,
      status: 'delegated',
      reason: outcome.reason,
      delegateTarget: outcome.target,
      createdOutboxIds: outcome.createdOutboxIds,
      reusedOutboxIds: outcome.reusedOutboxIds,
      queuedOutboxIds: outcome.queuedOutboxIds,
      enqueueFailedOutboxIds: outcome.enqueueFailedOutboxIds,
    };
  }

  if (outcome.kind === 'skipped') {
    return {
      kind: 'family_single',
      familyId: outcome.familyId,
      status: 'skipped',
      reason: outcome.reason,
      createdOutboxIds: outcome.createdOutboxIds,
      reusedOutboxIds: outcome.reusedOutboxIds,
      queuedOutboxIds: outcome.queuedOutboxIds,
      enqueueFailedOutboxIds: outcome.enqueueFailedOutboxIds,
    };
  }

  return {
    kind: 'family_single',
    familyId: outcome.familyId,
    status:
      outcome.enqueueFailedOutboxIds.length > 0 && outcome.queuedOutboxIds.length === 0
        ? 'partial'
        : 'queued',
    reason: outcome.reason,
    createdOutboxIds: outcome.createdOutboxIds,
    reusedOutboxIds: outcome.reusedOutboxIds,
    queuedOutboxIds: outcome.queuedOutboxIds,
    enqueueFailedOutboxIds: outcome.enqueueFailedOutboxIds,
  };
};

export const toFamilyBulkExecutionResult = (
  aggregation: CampaignNotificationFamilyBulkAggregation
): CampaignNotificationTriggerBulkExecutionResult => aggregation;
