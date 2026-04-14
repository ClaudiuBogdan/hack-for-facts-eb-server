import { err, ok, type Result } from 'neverthrow';

import {
  BUDGET_DOCUMENT_INTERACTION_ID,
  DEBATE_REQUEST_INTERACTION_ID,
} from '@/common/campaign-user-interactions.js';

import {
  buildCampaignInteractionFilters,
  getCampaignAdminReviewConfig,
} from '../campaign-admin-config.js';
import { createInvalidEventError, type LearningProgressError } from '../errors.js';

import type { LearningProgressRepository } from '../ports.js';
import type {
  CampaignAdminCampaignKey,
  CampaignAdminInteractionFilter,
  CampaignAdminInteractionRow,
  CampaignAdminListCursor,
  InteractionReviewSource,
  InteractionReviewStatus,
  ListCampaignAdminInteractionRowsOutput,
} from '../types.js';

export const REVIEWED_INTERACTION_SOURCE_INTERACTION_IDS = [
  BUDGET_DOCUMENT_INTERACTION_ID,
  DEBATE_REQUEST_INTERACTION_ID,
] as const;

const REVIEWED_INTERACTION_SOURCE_INTERACTION_ID_SET = new Set<string>(
  REVIEWED_INTERACTION_SOURCE_INTERACTION_IDS
);

export interface ReviewedInteractionCandidateIdentity {
  readonly userId: string;
  readonly recordKey: string;
}

export interface ListReviewedInteractionCandidatesInput {
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly reviewStatus?: InteractionReviewStatus;
  readonly reviewSource?: InteractionReviewSource;
  readonly interactionId?: string;
  readonly interactionIds?: readonly string[];
  readonly entityCui?: string;
  readonly userId?: string;
  readonly recordKey?: string;
  readonly submittedAtFrom?: string;
  readonly submittedAtTo?: string;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly limit: number;
  readonly cursor?: CampaignAdminListCursor;
}

export interface LoadLatestEntityInteractionRowInput {
  readonly campaignKey: CampaignAdminCampaignKey;
  readonly userId: string;
  readonly entityCui: string;
  readonly interactionId: string;
  readonly reviewSource?: InteractionReviewSource;
}

function resolveReviewedInteractionSourceFilters(
  campaignKey: CampaignAdminCampaignKey,
  interactionIds?: readonly string[]
): Result<readonly CampaignAdminInteractionFilter[], LearningProgressError> {
  const config = getCampaignAdminReviewConfig(campaignKey);
  if (config === null) {
    return err(
      createInvalidEventError(
        `Campaign "${campaignKey}" does not support reviewed-interaction candidates.`
      )
    );
  }

  const allowedInteractionIds = new Set<string>(
    (interactionIds ?? REVIEWED_INTERACTION_SOURCE_INTERACTION_IDS).filter((interactionId) =>
      REVIEWED_INTERACTION_SOURCE_INTERACTION_ID_SET.has(interactionId)
    )
  );

  if (allowedInteractionIds.size === 0) {
    return ok([]);
  }

  return ok(
    buildCampaignInteractionFilters({
      interactions: config.interactions.filter((interaction) => {
        return allowedInteractionIds.has(interaction.interactionId) && interaction.reviewable;
      }),
      kind: 'reviewable',
    })
  );
}

export async function loadReviewedInteractionCandidateByIdentity(
  deps: { repo: LearningProgressRepository },
  input: {
    readonly campaignKey: CampaignAdminCampaignKey;
    readonly identity: ReviewedInteractionCandidateIdentity;
    readonly reviewSource?: InteractionReviewSource;
  }
): Promise<Result<CampaignAdminInteractionRow | null, LearningProgressError>> {
  const sourceFiltersResult = resolveReviewedInteractionSourceFilters(input.campaignKey);
  if (sourceFiltersResult.isErr()) {
    return err(sourceFiltersResult.error);
  }

  const rowResult = await deps.repo.listCampaignAdminInteractionRows({
    campaignKey: input.campaignKey,
    interactions: sourceFiltersResult.value,
    userId: input.identity.userId,
    recordKey: input.identity.recordKey,
    ...(input.reviewSource !== undefined ? { reviewSource: input.reviewSource } : {}),
    limit: 1,
  });

  if (rowResult.isErr()) {
    return err(rowResult.error);
  }

  return ok(rowResult.value.rows[0] ?? null);
}

export async function listReviewedInteractionCandidates(
  deps: { repo: LearningProgressRepository },
  input: ListReviewedInteractionCandidatesInput
): Promise<Result<ListCampaignAdminInteractionRowsOutput, LearningProgressError>> {
  const interactionIds =
    input.interactionIds ?? (input.interactionId !== undefined ? [input.interactionId] : undefined);
  const sourceFiltersResult = resolveReviewedInteractionSourceFilters(
    input.campaignKey,
    interactionIds
  );
  if (sourceFiltersResult.isErr()) {
    return err(sourceFiltersResult.error);
  }

  return deps.repo.listCampaignAdminInteractionRows({
    campaignKey: input.campaignKey,
    interactions: sourceFiltersResult.value,
    ...(input.reviewStatus !== undefined ? { reviewStatus: input.reviewStatus } : {}),
    ...(input.reviewSource !== undefined ? { reviewSource: input.reviewSource } : {}),
    ...(input.entityCui !== undefined ? { entityCui: input.entityCui } : {}),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.recordKey !== undefined ? { recordKey: input.recordKey } : {}),
    ...(input.submittedAtFrom !== undefined ? { submittedAtFrom: input.submittedAtFrom } : {}),
    ...(input.submittedAtTo !== undefined ? { submittedAtTo: input.submittedAtTo } : {}),
    ...(input.updatedAtFrom !== undefined ? { updatedAtFrom: input.updatedAtFrom } : {}),
    ...(input.updatedAtTo !== undefined ? { updatedAtTo: input.updatedAtTo } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    limit: input.limit,
  });
}

export async function loadLatestEntityInteractionRow(
  deps: { repo: LearningProgressRepository },
  input: LoadLatestEntityInteractionRowInput
): Promise<Result<CampaignAdminInteractionRow | null, LearningProgressError>> {
  const rowResult = await deps.repo.listCampaignAdminInteractionRows({
    campaignKey: input.campaignKey,
    interactions: [{ interactionId: input.interactionId }],
    scopeType: 'entity',
    userId: input.userId,
    entityCui: input.entityCui,
    ...(input.reviewSource !== undefined ? { reviewSource: input.reviewSource } : {}),
    limit: 1,
  });

  if (rowResult.isErr()) {
    return err(rowResult.error);
  }

  return ok(rowResult.value.rows[0] ?? null);
}

export function hasStartedLatestEntityInteraction(
  row: CampaignAdminInteractionRow | null
): boolean {
  if (row === null) {
    return false;
  }

  return row.record.phase !== 'idle' && row.record.phase !== 'draft';
}
