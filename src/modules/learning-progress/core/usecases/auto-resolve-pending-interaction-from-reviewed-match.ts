import { err, ok, type Result } from 'neverthrow';

import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import {
  normalizeAutoReviewReuseRecord,
  type AutoReviewReuseNormalizedValue,
} from '../auto-review-reuse-normalization.js';
import { getCampaignAutoReviewReuseInteractionConfig } from '../campaign-admin-config.js';
import { jsonValuesAreEqual } from '../json-equality.js';
import { updateInteractionReview } from './update-interaction-review.js';

import type { LearningProgressError } from '../errors.js';
import type { LearningProgressRepository } from '../ports.js';
import type { LearningProgressRecordRow, ReviewDecisionStatus } from '../types.js';

export type AutoReviewReuseSkipReason =
  | 'record_not_found'
  | 'not_pending'
  | 'unsupported_scope'
  | 'interaction_not_enabled'
  | 'pending_value_invalid'
  | 'no_precedent'
  | 'precedent_invalid'
  | 'precedent_group_status_conflict'
  | 'precedent_group_value_conflict'
  | 'precedent_rejected'
  | 'value_mismatch';

export interface AutoResolvePendingInteractionFromReviewedMatchDeps {
  repo: LearningProgressRepository;
  onAutoApproved?: (input: {
    pendingUserId: string;
    pendingRecordKey: string;
    sourceUserId: string;
    sourceRecordKey: string;
    interactionId: string;
    entityCui: string;
  }) => void;
}

export interface AutoResolvePendingInteractionFromReviewedMatchInput {
  userId: string;
  recordKey: string;
}

export const AUTO_REVIEW_REUSE_SYSTEM_AUDIT_ADMIN_ID = 'system:audit:auto_review_reuse' as const;

export type AutoResolvePendingInteractionFromReviewedMatchOutput =
  | {
      readonly status: 'approved';
      readonly row: LearningProgressRecordRow;
      readonly sourceUserId: string;
      readonly sourceRecordKey: string;
    }
  | {
      readonly status: 'skipped';
      readonly reason: AutoReviewReuseSkipReason;
    };

function getAutoReviewReuseInteractionConfig(interactionId: string) {
  return getCampaignAutoReviewReuseInteractionConfig(FUNKY_CAMPAIGN_KEY, interactionId);
}

function isCampaignAdminApprovedOrRejectedReview(
  row: LearningProgressRecordRow
): row is LearningProgressRecordRow & {
  record: LearningProgressRecordRow['record'] & {
    review: {
      status: ReviewDecisionStatus;
      reviewedAt: string;
      reviewSource: 'campaign_admin_api';
    };
  };
} {
  const review = row.record.review;
  return (
    review !== undefined &&
    review !== null &&
    review.reviewedAt !== null &&
    review.reviewSource === 'campaign_admin_api' &&
    (review.status === 'approved' || review.status === 'rejected') &&
    (row.record.phase === 'resolved' || row.record.phase === 'failed')
  );
}

export async function autoResolvePendingInteractionFromReviewedMatch(
  deps: AutoResolvePendingInteractionFromReviewedMatchDeps,
  input: AutoResolvePendingInteractionFromReviewedMatchInput
): Promise<Result<AutoResolvePendingInteractionFromReviewedMatchOutput, LearningProgressError>> {
  return deps.repo.withTransaction(async (transactionalRepo) => {
    const initialRowResult = await transactionalRepo.getRecord(input.userId, input.recordKey);
    if (initialRowResult.isErr()) {
      return err(initialRowResult.error);
    }

    const initialRow = initialRowResult.value;
    if (initialRow === null) {
      return ok({
        status: 'skipped',
        reason: 'record_not_found',
      });
    }

    if (initialRow.record.phase !== 'pending') {
      return ok({
        status: 'skipped',
        reason: 'not_pending',
      });
    }

    if (initialRow.record.scope.type !== 'entity') {
      return ok({
        status: 'skipped',
        reason: 'unsupported_scope',
      });
    }

    const initialInteractionConfig = getAutoReviewReuseInteractionConfig(
      initialRow.record.interactionId
    );
    if (initialInteractionConfig === null) {
      return ok({
        status: 'skipped',
        reason: 'interaction_not_enabled',
      });
    }

    const lockResult = await transactionalRepo.acquireAutoReviewReuseTransactionLock({
      recordKey: initialRow.recordKey,
    });
    if (lockResult.isErr()) {
      return err(lockResult.error);
    }

    const rowResult = await transactionalRepo.getRecordForUpdate(input.userId, input.recordKey);
    if (rowResult.isErr()) {
      return err(rowResult.error);
    }

    const pendingRow = rowResult.value;
    if (pendingRow === null) {
      return ok({
        status: 'skipped',
        reason: 'record_not_found',
      });
    }

    if (pendingRow.record.phase !== 'pending') {
      return ok({
        status: 'skipped',
        reason: 'not_pending',
      });
    }

    if (pendingRow.record.scope.type !== 'entity') {
      return ok({
        status: 'skipped',
        reason: 'unsupported_scope',
      });
    }

    const interactionConfig = getAutoReviewReuseInteractionConfig(pendingRow.record.interactionId);
    if (interactionConfig === null) {
      return ok({
        status: 'skipped',
        reason: 'interaction_not_enabled',
      });
    }

    const normalizedPendingValue = normalizeAutoReviewReuseRecord(pendingRow.record);
    if (normalizedPendingValue.kind !== 'supported') {
      return ok({
        status: 'skipped',
        reason: 'pending_value_invalid',
      });
    }

    const precedentRowsResult =
      await transactionalRepo.findLatestCampaignAdminReviewedExactKeyMatches({
        recordKey: pendingRow.recordKey,
        interactionId: pendingRow.record.interactionId,
        entityCui: pendingRow.record.scope.entityCui,
      });
    if (precedentRowsResult.isErr()) {
      return err(precedentRowsResult.error);
    }

    const precedentRows = precedentRowsResult.value;
    if (precedentRows.length === 0) {
      return ok({
        status: 'skipped',
        reason: 'no_precedent',
      });
    }

    let selectedSourceRow: LearningProgressRecordRow | null = null;
    let selectedStatus: ReviewDecisionStatus | null = null;
    let selectedNormalizedValue: AutoReviewReuseNormalizedValue | null = null;

    for (const precedentRow of precedentRows) {
      if (!isCampaignAdminApprovedOrRejectedReview(precedentRow)) {
        return ok({
          status: 'skipped',
          reason: 'precedent_invalid',
        });
      }

      const normalizedPrecedentValue = normalizeAutoReviewReuseRecord(precedentRow.record);
      if (normalizedPrecedentValue.kind !== 'supported') {
        return ok({
          status: 'skipped',
          reason: 'precedent_invalid',
        });
      }

      if (selectedSourceRow === null) {
        selectedSourceRow = precedentRow;
        selectedStatus = precedentRow.record.review.status;
        selectedNormalizedValue = normalizedPrecedentValue.value;
        continue;
      }

      if (selectedStatus !== precedentRow.record.review.status) {
        return ok({
          status: 'skipped',
          reason: 'precedent_group_status_conflict',
        });
      }

      if (
        selectedNormalizedValue === null ||
        !jsonValuesAreEqual(selectedNormalizedValue, normalizedPrecedentValue.value)
      ) {
        return ok({
          status: 'skipped',
          reason: 'precedent_group_value_conflict',
        });
      }
    }

    if (selectedSourceRow === null || selectedStatus === null || selectedNormalizedValue === null) {
      return ok({
        status: 'skipped',
        reason: 'no_precedent',
      });
    }

    if (selectedStatus === 'rejected') {
      return ok({
        status: 'skipped',
        reason: 'precedent_rejected',
      });
    }

    if (!jsonValuesAreEqual(normalizedPendingValue.value, selectedNormalizedValue)) {
      return ok({
        status: 'skipped',
        reason: 'value_mismatch',
      });
    }

    const updateResult = await updateInteractionReview(
      { repo: transactionalRepo },
      {
        userId: pendingRow.userId,
        recordKey: pendingRow.recordKey,
        expectedUpdatedAt: pendingRow.updatedAt,
        status: 'approved',
        actor: {
          actor: 'admin',
          actorUserId: AUTO_REVIEW_REUSE_SYSTEM_AUDIT_ADMIN_ID,
          actorSource: 'auto_review_reuse_match',
        },
      }
    );
    if (updateResult.isErr()) {
      if (updateResult.error.type === 'ConflictError') {
        return ok({
          status: 'skipped',
          reason: 'not_pending',
        });
      }

      if (updateResult.error.type === 'NotFoundError') {
        return ok({
          status: 'skipped',
          reason: 'record_not_found',
        });
      }

      return err(updateResult.error);
    }

    if (updateResult.value.applied) {
      deps.onAutoApproved?.({
        pendingUserId: pendingRow.userId,
        pendingRecordKey: pendingRow.recordKey,
        sourceUserId: selectedSourceRow.userId,
        sourceRecordKey: selectedSourceRow.recordKey,
        interactionId: pendingRow.record.interactionId,
        entityCui: pendingRow.record.scope.entityCui,
      });
    }

    return ok({
      status: 'approved',
      row: updateResult.value.row,
      sourceUserId: selectedSourceRow.userId,
      sourceRecordKey: selectedSourceRow.recordKey,
    });
  });
}
