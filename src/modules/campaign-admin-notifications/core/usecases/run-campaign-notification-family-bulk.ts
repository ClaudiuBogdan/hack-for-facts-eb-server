import { err, ok } from 'neverthrow';

import {
  emptyFamilyBulkAggregation,
  toFamilyBulkExecutionResult,
  type CampaignNotificationFamilyBulkAggregation,
  type CampaignNotificationFamilyBulkExecutionInput,
  type CampaignNotificationFamilyDefinition,
  type CampaignNotificationFamilyExecutionOutcome,
} from '../family-runner.js';

const accumulateOutcome = (
  current: CampaignNotificationFamilyBulkAggregation,
  input: {
    readonly planned: boolean;
    readonly outcome: CampaignNotificationFamilyExecutionOutcome;
  }
): CampaignNotificationFamilyBulkAggregation => {
  const base = {
    ...current,
    candidateCount: current.candidateCount + 1,
    plannedCount: current.plannedCount + (input.planned ? 1 : 0),
  };

  if (input.outcome.kind === 'delegated') {
    return {
      ...base,
      delegatedCount: base.delegatedCount + 1,
    };
  }

  if (input.outcome.kind === 'skipped') {
    return {
      ...base,
      skippedCount: base.skippedCount + 1,
      ineligibleCount:
        input.outcome.category === 'ineligible' ? base.ineligibleCount + 1 : base.ineligibleCount,
      notReplayableCount:
        input.outcome.category === 'not_replayable'
          ? base.notReplayableCount + 1
          : base.notReplayableCount,
      staleCount: input.outcome.category === 'stale' ? base.staleCount + 1 : base.staleCount,
    };
  }

  return {
    ...base,
    eligibleCount: base.eligibleCount + 1,
    queuedCount:
      input.outcome.dryRun || input.outcome.queuedOutboxIds.length > 0
        ? base.queuedCount + 1
        : base.queuedCount,
    reusedCount: input.outcome.source === 'reused' ? base.reusedCount + 1 : base.reusedCount,
    enqueueFailedCount:
      input.outcome.enqueueFailedOutboxIds.length > 0
        ? base.enqueueFailedCount + 1
        : base.enqueueFailedCount,
  };
};

export const runCampaignNotificationFamilyBulk = async <
  TBulkFilters,
  TCandidate,
  TEnrichment,
  TQueuedPlan,
  TCursor,
>(
  family: CampaignNotificationFamilyDefinition<
    never,
    TBulkFilters,
    TCandidate,
    TEnrichment,
    TQueuedPlan,
    TCursor
  >,
  input: CampaignNotificationFamilyBulkExecutionInput<TBulkFilters>
) => {
  const watermarkResult = await family.captureBulkWatermark(input.filters);
  if (watermarkResult.isErr()) {
    return err(watermarkResult.error);
  }

  const watermark = watermarkResult.value;
  let aggregation = emptyFamilyBulkAggregation({
    familyId: family.familyId,
    dryRun: input.context.dryRun,
    watermark,
    limit: input.limit,
  });
  let cursor: TCursor | undefined;

  while (aggregation.candidateCount < input.limit) {
    const remaining = input.limit - aggregation.candidateCount;
    const pageResult = await family.loadBulkPage({
      filters: input.filters,
      watermark,
      pageLimit: remaining,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (pageResult.isErr()) {
      return err(pageResult.error);
    }

    const page = pageResult.value;
    if (page.items.length === 0) {
      aggregation = {
        ...aggregation,
        hasMoreCandidates: page.hasMore,
      };
      break;
    }

    for (const candidate of page.items) {
      const enrichmentResult = await family.enrichCandidate(candidate);
      if (enrichmentResult.isErr()) {
        return err(enrichmentResult.error);
      }

      const plan = family.planCandidate({
        candidate,
        enrichment: enrichmentResult.value,
        context: {
          campaignKey: input.context.campaignKey,
          triggerSource: input.context.triggerSource,
          actorUserId: input.context.actorUserId,
        },
      });

      const executionResult = await family.executePlan({
        candidate,
        enrichment: enrichmentResult.value,
        plan,
        context: input.context,
      });
      if (executionResult.isErr()) {
        return err(executionResult.error);
      }

      aggregation = accumulateOutcome(aggregation, {
        planned: plan.disposition === 'queue',
        outcome: executionResult.value,
      });

      if (aggregation.candidateCount >= input.limit) {
        break;
      }
    }

    if (aggregation.candidateCount >= input.limit) {
      aggregation = {
        ...aggregation,
        hasMoreCandidates: page.hasMore || page.nextCursor !== null,
      };
      break;
    }

    if (!page.hasMore || page.nextCursor === null) {
      aggregation = {
        ...aggregation,
        hasMoreCandidates: false,
      };
      break;
    }

    cursor = page.nextCursor;
  }

  return ok(toFamilyBulkExecutionResult(aggregation));
};
