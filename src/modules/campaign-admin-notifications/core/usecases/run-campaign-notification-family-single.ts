import { err } from 'neverthrow';

import { createNotFoundError } from '../errors.js';
import {
  toFamilySingleExecutionResult,
  type CampaignNotificationFamilyContext,
  type CampaignNotificationFamilyDefinition,
} from '../family-runner.js';

export const runCampaignNotificationFamilySingle = async <
  TSingleInput,
  TBulkFilters,
  TCandidate,
  TEnrichment,
  TQueuedPlan,
  TCursor,
>(
  family: CampaignNotificationFamilyDefinition<
    TSingleInput,
    TBulkFilters,
    TCandidate,
    TEnrichment,
    TQueuedPlan,
    TCursor
  >,
  input: {
    readonly candidate: TSingleInput;
    readonly context: Readonly<CampaignNotificationFamilyContext>;
  }
) => {
  const candidateResult = await family.loadSingleCandidate(input.candidate);
  if (candidateResult.isErr()) {
    return err(candidateResult.error);
  }

  if (candidateResult.value === null) {
    return err(createNotFoundError('Campaign notification family candidate was not found.'));
  }

  const enrichmentResult = await family.enrichCandidate(candidateResult.value);
  if (enrichmentResult.isErr()) {
    return err(enrichmentResult.error);
  }

  const plan = family.planCandidate({
    candidate: candidateResult.value,
    enrichment: enrichmentResult.value,
    context: {
      campaignKey: input.context.campaignKey,
      triggerSource: input.context.triggerSource,
      actorUserId: input.context.actorUserId,
    },
  });

  const executionResult = await family.executePlan({
    candidate: candidateResult.value,
    enrichment: enrichmentResult.value,
    plan,
    context: input.context,
  });
  if (executionResult.isErr()) {
    return err(executionResult.error);
  }

  return executionResult.map(toFamilySingleExecutionResult);
};
