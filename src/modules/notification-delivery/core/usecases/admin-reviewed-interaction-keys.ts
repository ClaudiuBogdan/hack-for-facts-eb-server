import type { AdminReviewedInteractionOutboxMetadata } from '../reviewed-interaction.js';

export interface AdminReviewedInteractionKeyInput {
  campaignKey: string;
  userId: string;
  interactionId: string;
  recordKey: string;
  reviewedAt: string;
  reviewStatus: AdminReviewedInteractionOutboxMetadata['reviewStatus'];
}

const buildOccurrenceKey = ({
  campaignKey,
  userId,
  interactionId,
  recordKey,
  reviewedAt,
  reviewStatus,
}: AdminReviewedInteractionKeyInput): string => {
  return `reviewed_interaction:${campaignKey}:${userId}:${interactionId}:${recordKey}:${reviewedAt}:${reviewStatus}`;
};

export const buildAdminReviewedInteractionDeliveryKey = (
  input: AdminReviewedInteractionKeyInput
): string => {
  return buildOccurrenceKey(input);
};

export const buildAdminReviewedInteractionScopeKey = (
  input: AdminReviewedInteractionKeyInput
): string => {
  return buildOccurrenceKey(input);
};
