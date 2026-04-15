import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok } from 'neverthrow';

import { TEMPLATE_VERSION } from '@/modules/email-templates/index.js';
import {
  enqueueAdminReviewedInteractionNotification,
  getErrorMessage,
  type EnqueueAdminReviewedInteractionNotificationResult,
} from '@/modules/notification-delivery/index.js';

import {
  createAdminReviewedInteractionFamily,
  type ReviewedInteractionQueuedPlan,
  type ReviewedInteractionTriggerDeps,
} from './admin-reviewed-interaction-trigger.js';
import { createDatabaseError, createValidationError } from '../../core/errors.js';
import { ADMIN_REVIEWED_USER_INTERACTION_TEMPLATE_ID } from '../../core/reviewed-interaction.js';
import { listSchemaFields } from '../shared/schema-field-descriptors.js';

import type { CampaignNotificationRunnableTemplateDefinition } from '../../core/ports.js';
import type {
  CampaignNotificationRunnablePlanRow,
  CampaignNotificationRunnablePlanSummary,
  CampaignNotificationStoredPlanRow,
} from '../../core/types.js';
import type { CampaignAdminListCursor } from '@/modules/learning-progress/index.js';

const ReviewStatusSchema = Type.Union([Type.Literal('approved'), Type.Literal('rejected')]);
const ReviewedInteractionRunnableSelectorsSchema = Type.Object(
  {
    userId: Type.Optional(Type.String({ minLength: 1 })),
    entityCui: Type.Optional(Type.String({ minLength: 1 })),
    recordKey: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);
const ReviewedInteractionRunnableFiltersSchema = Type.Object(
  {
    reviewStatus: Type.Optional(ReviewStatusSchema),
    interactionId: Type.Optional(Type.String({ minLength: 1 })),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    submittedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    submittedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false }
);

interface ReviewedInteractionRunnableSelectors {
  readonly userId?: string;
  readonly entityCui?: string;
  readonly recordKey?: string;
}

interface ReviewedInteractionRunnableFilters {
  readonly reviewStatus?: 'approved' | 'rejected';
  readonly interactionId?: string;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly submittedAtFrom?: string;
  readonly submittedAtTo?: string;
}

interface ReviewedInteractionExecutionData {
  readonly kind: 'admin_reviewed_interaction';
  readonly candidateIdentity: {
    readonly userId: string;
    readonly recordKey: string;
  };
  readonly notificationInput: ReviewedInteractionQueuedPlan['notificationInput'];
}

const RUNNABLE_ID = 'admin_reviewed_user_interaction';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_PLAN_ROW_COUNT = 200;
const DRY_RUN_FETCH_PAGE_SIZE = 100;

const createEmptySummary = (): CampaignNotificationRunnablePlanSummary => ({
  totalRowCount: 0,
  willSendCount: 0,
  alreadySentCount: 0,
  alreadyPendingCount: 0,
  ineligibleCount: 0,
  missingDataCount: 0,
});

const addSummaryRow = (
  summary: CampaignNotificationRunnablePlanSummary,
  status: CampaignNotificationRunnablePlanRow['status']
): CampaignNotificationRunnablePlanSummary => {
  switch (status) {
    case 'will_send':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        willSendCount: summary.willSendCount + 1,
      };
    case 'already_sent':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        alreadySentCount: summary.alreadySentCount + 1,
      };
    case 'already_pending':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        alreadyPendingCount: summary.alreadyPendingCount + 1,
      };
    case 'ineligible':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        ineligibleCount: summary.ineligibleCount + 1,
      };
    case 'missing_data':
      return {
        ...summary,
        totalRowCount: summary.totalRowCount + 1,
        missingDataCount: summary.missingDataCount + 1,
      };
  }
};

const buildRowKey = (input: {
  readonly userId: string;
  readonly recordKey: string;
  readonly reviewStatus: 'approved' | 'rejected' | null;
  readonly reviewedAt: string | null;
}): string => {
  return [
    input.userId,
    input.recordKey,
    input.reviewStatus ?? 'unknown',
    input.reviewedAt ?? 'unknown',
  ].join(':');
};

const basePreviewRow = (input: {
  readonly userId: string;
  readonly entityCui: string | null;
  readonly entityName: string | null;
  readonly recordKey: string;
  readonly interactionId: string;
  readonly interactionLabel: string | null;
  readonly reviewStatus: 'approved' | 'rejected' | null;
  readonly reviewedAt: string | null;
  readonly status: CampaignNotificationRunnablePlanRow['status'];
  readonly reasonCode: string;
  readonly statusMessage: string;
  readonly hasExistingDelivery: boolean;
  readonly existingDeliveryStatus: string | null;
  readonly sendMode: CampaignNotificationRunnablePlanRow['sendMode'];
}): CampaignNotificationRunnablePlanRow => {
  return {
    rowKey: buildRowKey({
      userId: input.userId,
      recordKey: input.recordKey,
      reviewStatus: input.reviewStatus,
      reviewedAt: input.reviewedAt,
    }),
    userId: input.userId,
    entityCui: input.entityCui,
    entityName: input.entityName,
    recordKey: input.recordKey,
    interactionId: input.interactionId,
    interactionLabel: input.interactionLabel,
    reviewStatus: input.reviewStatus,
    reviewedAt: input.reviewedAt,
    status: input.status,
    reasonCode: input.reasonCode,
    statusMessage: input.statusMessage,
    hasExistingDelivery: input.hasExistingDelivery,
    existingDeliveryStatus: input.existingDeliveryStatus,
    sendMode: input.sendMode,
  };
};

const toStatusMessage = (input: {
  readonly status: CampaignNotificationRunnablePlanRow['status'];
  readonly reasonCode: string;
}): string => {
  switch (input.reasonCode) {
    case 'eligible_now':
      return 'Ready to send.';
    case 'existing_failed_transient':
      return 'A retryable failed delivery exists and can be reused.';
    case 'existing_pending':
      return 'A notification is already pending for this reviewed interaction.';
    case 'existing_sent':
      return 'A notification for this reviewed interaction was already sent.';
    case 'existing_not_replayable':
      return 'A previous notification already exists and cannot be replayed.';
    case 'missing_preference':
      return 'The user does not have an active entity-updates subscription for this entity.';
    case 'inactive_preference':
      return 'The entity-updates subscription for this entity is inactive.';
    case 'global_unsubscribe':
      return 'The user is globally unsubscribed from email notifications.';
    case 'campaign_disabled':
      return 'Campaign notifications are disabled for this user.';
    case 'unsupported_scope':
      return 'This interaction scope is not supported for this notification.';
    case 'unsupported_interaction':
      return 'This interaction type is not supported for this notification.';
    case 'not_admin_reviewed':
      return 'This interaction is no longer in an admin-reviewed state.';
    case 'stale_occurrence':
      return 'This reviewed interaction changed after the preview was created.';
    default:
      switch (input.status) {
        case 'will_send':
          return 'Ready to send.';
        case 'already_sent':
          return 'A notification was already sent for this reviewed interaction.';
        case 'already_pending':
          return 'A notification is already pending for this reviewed interaction.';
        case 'ineligible':
          return 'This user is not currently eligible to receive this notification.';
        case 'missing_data':
          return 'The reviewed interaction no longer has the data required to send this notification.';
      }
  }
};

const toStoredDryRunRow = (input: {
  readonly candidate: {
    readonly userId: string;
    readonly recordKey: string;
    readonly interactionId: string;
    readonly reviewStatus: 'approved' | 'rejected' | null;
    readonly reviewedAt: string | null;
  };
  readonly entityCui: string | null;
  readonly entityName: string | null;
  readonly interactionLabel: string | null;
  readonly reasonCode: string;
  readonly evaluation: EnqueueAdminReviewedInteractionNotificationResult;
  readonly notificationInput: ReviewedInteractionQueuedPlan['notificationInput'];
}): CampaignNotificationStoredPlanRow => {
  if (input.evaluation.reason === 'eligible_now') {
    return {
      preview: basePreviewRow({
        userId: input.candidate.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        recordKey: input.candidate.recordKey,
        interactionId: input.candidate.interactionId,
        interactionLabel: input.interactionLabel,
        reviewStatus: input.candidate.reviewStatus,
        reviewedAt: input.candidate.reviewedAt,
        status: 'will_send',
        reasonCode: input.reasonCode,
        statusMessage: toStatusMessage({
          status: 'will_send',
          reasonCode: input.reasonCode,
        }),
        hasExistingDelivery: false,
        existingDeliveryStatus: null,
        sendMode: 'create',
      }),
      executionData: {
        kind: 'admin_reviewed_interaction',
        candidateIdentity: {
          userId: input.candidate.userId,
          recordKey: input.candidate.recordKey,
        },
        notificationInput: input.notificationInput,
      },
    };
  }

  if (input.evaluation.reason === 'existing_failed_transient') {
    return {
      preview: basePreviewRow({
        userId: input.candidate.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        recordKey: input.candidate.recordKey,
        interactionId: input.candidate.interactionId,
        interactionLabel: input.interactionLabel,
        reviewStatus: input.candidate.reviewStatus,
        reviewedAt: input.candidate.reviewedAt,
        status: 'will_send',
        reasonCode: input.reasonCode,
        statusMessage: toStatusMessage({
          status: 'will_send',
          reasonCode: input.reasonCode,
        }),
        hasExistingDelivery: true,
        existingDeliveryStatus: input.evaluation.outboxStatus ?? 'failed_transient',
        sendMode: 'reuse_claimable',
      }),
      executionData: {
        kind: 'admin_reviewed_interaction',
        candidateIdentity: {
          userId: input.candidate.userId,
          recordKey: input.candidate.recordKey,
        },
        notificationInput: input.notificationInput,
      },
    };
  }

  if (input.evaluation.reason === 'existing_pending') {
    return {
      preview: basePreviewRow({
        userId: input.candidate.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        recordKey: input.candidate.recordKey,
        interactionId: input.candidate.interactionId,
        interactionLabel: input.interactionLabel,
        reviewStatus: input.candidate.reviewStatus,
        reviewedAt: input.candidate.reviewedAt,
        status: 'already_pending',
        reasonCode: input.reasonCode,
        statusMessage: toStatusMessage({
          status: 'already_pending',
          reasonCode: input.reasonCode,
        }),
        hasExistingDelivery: true,
        existingDeliveryStatus: input.evaluation.outboxStatus ?? 'pending',
        sendMode: null,
      }),
      executionData: null,
    };
  }

  if (
    input.evaluation.reason === 'existing_sent' ||
    input.evaluation.reason === 'existing_not_replayable'
  ) {
    return {
      preview: basePreviewRow({
        userId: input.candidate.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        recordKey: input.candidate.recordKey,
        interactionId: input.candidate.interactionId,
        interactionLabel: input.interactionLabel,
        reviewStatus: input.candidate.reviewStatus,
        reviewedAt: input.candidate.reviewedAt,
        status: 'already_sent',
        reasonCode: input.reasonCode,
        statusMessage: toStatusMessage({
          status: 'already_sent',
          reasonCode: input.reasonCode,
        }),
        hasExistingDelivery: true,
        existingDeliveryStatus: input.evaluation.outboxStatus ?? null,
        sendMode: null,
      }),
      executionData: null,
    };
  }

  if (input.evaluation.reason === 'ineligible_now') {
    return {
      preview: basePreviewRow({
        userId: input.candidate.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        recordKey: input.candidate.recordKey,
        interactionId: input.candidate.interactionId,
        interactionLabel: input.interactionLabel,
        reviewStatus: input.candidate.reviewStatus,
        reviewedAt: input.candidate.reviewedAt,
        status: 'ineligible',
        reasonCode: input.evaluation.eligibility.reason,
        statusMessage: toStatusMessage({
          status: 'ineligible',
          reasonCode: input.evaluation.eligibility.reason,
        }),
        hasExistingDelivery: false,
        existingDeliveryStatus: null,
        sendMode: null,
      }),
      executionData: null,
    };
  }

  return {
    preview: basePreviewRow({
      userId: input.candidate.userId,
      entityCui: input.entityCui,
      entityName: input.entityName,
      recordKey: input.candidate.recordKey,
      interactionId: input.candidate.interactionId,
      interactionLabel: input.interactionLabel,
      reviewStatus: input.candidate.reviewStatus,
      reviewedAt: input.candidate.reviewedAt,
      status: 'missing_data',
      reasonCode: input.reasonCode,
      statusMessage: toStatusMessage({
        status: 'missing_data',
        reasonCode: input.reasonCode,
      }),
      hasExistingDelivery: false,
      existingDeliveryStatus: null,
      sendMode: null,
    }),
    executionData: null,
  };
};

const mapLiveSendOutcome = (
  result: EnqueueAdminReviewedInteractionNotificationResult
):
  | 'queued'
  | 'already_sent'
  | 'already_pending'
  | 'ineligible'
  | 'missing_data'
  | 'enqueue_failed' => {
  if (result.status === 'queued') {
    return 'queued';
  }

  if (result.status === 'recorded' && result.reason === 'enqueue_failed') {
    return 'enqueue_failed';
  }

  if (result.reason === 'existing_pending') {
    return 'already_pending';
  }

  if (result.reason === 'ineligible_now') {
    return 'ineligible';
  }

  if (result.reason === 'stale_occurrence') {
    return 'missing_data';
  }

  return 'already_sent';
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isValidNextStepLink = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as {
    kind?: unknown;
    label?: unknown;
    url?: unknown;
    description?: unknown;
  };

  return (
    (candidate.kind === 'retry_interaction' ||
      candidate.kind === 'start_public_debate_request' ||
      candidate.kind === 'view_entity') &&
    isNonEmptyString(candidate.label) &&
    isNonEmptyString(candidate.url) &&
    (candidate.description === undefined || isNonEmptyString(candidate.description))
  );
};

const parseExecutionData = (
  value: Record<string, unknown> | null
): ReviewedInteractionExecutionData | null => {
  if (value === null) {
    return null;
  }

  const candidateIdentity = value['candidateIdentity'];
  const notificationInput = value['notificationInput'];
  const nextStepLinks = (notificationInput as { nextStepLinks?: unknown } | null)?.nextStepLinks;
  const feedbackText = (notificationInput as { feedbackText?: unknown } | null)?.feedbackText;
  if (
    value['kind'] !== 'admin_reviewed_interaction' ||
    typeof candidateIdentity !== 'object' ||
    candidateIdentity === null ||
    typeof (candidateIdentity as { userId?: unknown }).userId !== 'string' ||
    typeof (candidateIdentity as { recordKey?: unknown }).recordKey !== 'string' ||
    typeof notificationInput !== 'object' ||
    notificationInput === null ||
    typeof (notificationInput as { userId?: unknown }).userId !== 'string' ||
    typeof (notificationInput as { entityCui?: unknown }).entityCui !== 'string' ||
    typeof (notificationInput as { entityName?: unknown }).entityName !== 'string' ||
    typeof (notificationInput as { recordKey?: unknown }).recordKey !== 'string' ||
    typeof (notificationInput as { interactionId?: unknown }).interactionId !== 'string' ||
    typeof (notificationInput as { interactionLabel?: unknown }).interactionLabel !== 'string' ||
    ((notificationInput as { reviewStatus?: unknown }).reviewStatus !== 'approved' &&
      (notificationInput as { reviewStatus?: unknown }).reviewStatus !== 'rejected') ||
    typeof (notificationInput as { reviewedAt?: unknown }).reviewedAt !== 'string' ||
    (feedbackText !== undefined && !isNonEmptyString(feedbackText)) ||
    (nextStepLinks !== undefined &&
      (!Array.isArray(nextStepLinks) ||
        nextStepLinks.length === 0 ||
        !nextStepLinks.every((link) => isValidNextStepLink(link))))
  ) {
    return null;
  }

  return value as unknown as ReviewedInteractionExecutionData;
};

const matchesStoredOccurrence = (input: {
  readonly live: ReviewedInteractionQueuedPlan['notificationInput'];
  readonly stored: ReviewedInteractionQueuedPlan['notificationInput'];
}): boolean => {
  return (
    input.live.userId === input.stored.userId &&
    input.live.entityCui === input.stored.entityCui &&
    input.live.recordKey === input.stored.recordKey &&
    input.live.interactionId === input.stored.interactionId &&
    input.live.reviewStatus === input.stored.reviewStatus &&
    input.live.reviewedAt === input.stored.reviewedAt
  );
};

export const makeAdminReviewedInteractionRunnableDefinition = (
  deps: ReviewedInteractionTriggerDeps
): CampaignNotificationRunnableTemplateDefinition => {
  const family = createAdminReviewedInteractionFamily(deps);

  return {
    runnableId: RUNNABLE_ID,
    campaignKey: 'funky',
    templateId: ADMIN_REVIEWED_USER_INTERACTION_TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    description:
      'Dry-run and send reviewed interaction notifications from the admin surface using stored plans.',
    selectorSchema: ReviewedInteractionRunnableSelectorsSchema,
    filterSchema: ReviewedInteractionRunnableFiltersSchema,
    selectors: listSchemaFields(ReviewedInteractionRunnableSelectorsSchema),
    filters: listSchemaFields(ReviewedInteractionRunnableFiltersSchema),
    targetKind: 'user_interaction',
    dryRunRequired: true,
    maxPlanRowCount: MAX_PLAN_ROW_COUNT,
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
    async dryRun(input) {
      if (
        !Value.Check(ReviewedInteractionRunnableSelectorsSchema, input.selectors) ||
        !Value.Check(ReviewedInteractionRunnableFiltersSchema, input.filters)
      ) {
        return err(createValidationError('Invalid reviewed interaction runnable payload.'));
      }

      const selectors = input.selectors as ReviewedInteractionRunnableSelectors;
      const filters = input.filters as ReviewedInteractionRunnableFilters;
      const watermarkResult = await family.captureBulkWatermark({});
      if (watermarkResult.isErr()) {
        return err(watermarkResult.error);
      }

      const rows: CampaignNotificationStoredPlanRow[] = [];
      let summary = createEmptySummary();
      let cursor: CampaignAdminListCursor | undefined;
      let hasMore = true;

      while (hasMore) {
        const pageResult = await family.loadBulkPage({
          filters: {
            ...(selectors.userId !== undefined ? { userId: selectors.userId } : {}),
            ...(selectors.entityCui !== undefined ? { entityCui: selectors.entityCui } : {}),
            ...(selectors.recordKey !== undefined ? { recordKey: selectors.recordKey } : {}),
            ...(filters.reviewStatus !== undefined ? { reviewStatus: filters.reviewStatus } : {}),
            ...(filters.interactionId !== undefined
              ? { interactionId: filters.interactionId }
              : {}),
            ...(filters.updatedAtFrom !== undefined
              ? { updatedAtFrom: filters.updatedAtFrom }
              : {}),
            ...(filters.updatedAtTo !== undefined ? { updatedAtTo: filters.updatedAtTo } : {}),
            ...(filters.submittedAtFrom !== undefined
              ? { submittedAtFrom: filters.submittedAtFrom }
              : {}),
            ...(filters.submittedAtTo !== undefined
              ? { submittedAtTo: filters.submittedAtTo }
              : {}),
          },
          watermark: watermarkResult.value,
          pageLimit: DRY_RUN_FETCH_PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (pageResult.isErr()) {
          return err(pageResult.error);
        }

        for (const candidate of pageResult.value.items) {
          const enrichmentResult = await family.enrichCandidate(candidate);
          if (enrichmentResult.isErr()) {
            return err(enrichmentResult.error);
          }

          const plan = family.planCandidate({
            candidate,
            enrichment: enrichmentResult.value,
            context: {
              campaignKey: 'funky',
              actorUserId: input.actorUserId,
              triggerSource: 'campaign_admin',
            },
          });

          if (plan.disposition === 'delegate' && plan.reason === 'approved_public_debate_request') {
            continue;
          }

          if (plan.disposition === 'skip') {
            const storedRow: CampaignNotificationStoredPlanRow = {
              preview: basePreviewRow({
                userId: candidate.userId,
                entityCui: enrichmentResult.value.entityCui,
                entityName: enrichmentResult.value.entityName,
                recordKey: candidate.recordKey,
                interactionId: candidate.record.interactionId,
                interactionLabel: enrichmentResult.value.interactionLabel,
                reviewStatus:
                  candidate.record.review?.status === 'approved' ||
                  candidate.record.review?.status === 'rejected'
                    ? candidate.record.review.status
                    : null,
                reviewedAt: candidate.record.review?.reviewedAt ?? null,
                status: 'missing_data',
                reasonCode: plan.reason,
                statusMessage: toStatusMessage({
                  status: 'missing_data',
                  reasonCode: plan.reason,
                }),
                hasExistingDelivery: false,
                existingDeliveryStatus: null,
                sendMode: null,
              }),
              executionData: null,
            };
            rows.push(storedRow);
            summary = addSummaryRow(summary, storedRow.preview.status);
          } else if (plan.disposition === 'queue') {
            const dryRunResult = await enqueueAdminReviewedInteractionNotification(
              {
                notificationsRepo: deps.extendedNotificationsRepo,
                deliveryRepo: deps.deliveryRepo,
                composeJobScheduler: deps.composeJobScheduler,
              },
              {
                runId: `campaign-admin-runnable-dry-run-${randomUUID()}`,
                dryRun: true,
                triggerSource: 'campaign_admin',
                triggeredByUserId: input.actorUserId,
                ...plan.queuedPlan.notificationInput,
              }
            );
            if (dryRunResult.isErr()) {
              return err(
                createDatabaseError(
                  getErrorMessage(dryRunResult.error),
                  'retryable' in dryRunResult.error ? dryRunResult.error.retryable : false
                )
              );
            }

            const storedRow = toStoredDryRunRow({
              candidate: {
                userId: candidate.userId,
                recordKey: candidate.recordKey,
                interactionId: candidate.record.interactionId,
                reviewStatus: plan.queuedPlan.notificationInput.reviewStatus,
                reviewedAt: plan.queuedPlan.notificationInput.reviewedAt,
              },
              entityCui: plan.queuedPlan.notificationInput.entityCui,
              entityName: plan.queuedPlan.notificationInput.entityName,
              interactionLabel: plan.queuedPlan.notificationInput.interactionLabel,
              reasonCode: dryRunResult.value.reason,
              evaluation: dryRunResult.value,
              notificationInput: plan.queuedPlan.notificationInput,
            });
            rows.push(storedRow);
            summary = addSummaryRow(summary, storedRow.preview.status);
          } else {
            continue;
          }

          if (rows.length > MAX_PLAN_ROW_COUNT) {
            return err(
              createValidationError(
                `Dry run exceeds the ${String(MAX_PLAN_ROW_COUNT)} row safety cap. Narrow selectors or filters.`
              )
            );
          }
        }

        hasMore = pageResult.value.hasMore;
        cursor = pageResult.value.nextCursor ?? undefined;
      }

      return ok({
        watermark: watermarkResult.value,
        summary,
        rows,
      });
    },
    async executeStoredRow(input) {
      const executionData = parseExecutionData(input.row.executionData);
      if (executionData === null) {
        return ok({ outcome: 'missing_data' as const });
      }

      const candidateResult = await family.loadSingleCandidate(executionData.candidateIdentity);
      if (candidateResult.isErr()) {
        return err(candidateResult.error);
      }

      if (candidateResult.value === null) {
        return ok({ outcome: 'missing_data' as const });
      }

      const enrichmentResult = await family.enrichCandidate(candidateResult.value);
      if (enrichmentResult.isErr()) {
        return err(enrichmentResult.error);
      }

      const livePlan = family.planCandidate({
        candidate: candidateResult.value,
        enrichment: enrichmentResult.value,
        context: {
          campaignKey: 'funky',
          actorUserId: input.actorUserId,
          triggerSource: 'campaign_admin',
        },
      });
      if (livePlan.disposition !== 'queue') {
        return ok({ outcome: 'missing_data' as const });
      }

      if (
        !matchesStoredOccurrence({
          live: livePlan.queuedPlan.notificationInput,
          stored: executionData.notificationInput,
        })
      ) {
        return ok({ outcome: 'missing_data' as const });
      }

      const enqueueResult = await enqueueAdminReviewedInteractionNotification(
        {
          notificationsRepo: deps.extendedNotificationsRepo,
          deliveryRepo: deps.deliveryRepo,
          composeJobScheduler: deps.composeJobScheduler,
        },
        {
          runId: `campaign-admin-runnable-send-${randomUUID()}`,
          dryRun: false,
          triggerSource: 'campaign_admin',
          triggeredByUserId: input.actorUserId,
          ...executionData.notificationInput,
        }
      );
      if (enqueueResult.isErr()) {
        return err(
          createDatabaseError(
            getErrorMessage(enqueueResult.error),
            'retryable' in enqueueResult.error ? enqueueResult.error.retryable : false
          )
        );
      }

      return ok({
        outcome: mapLiveSendOutcome(enqueueResult.value),
      });
    },
  };
};
