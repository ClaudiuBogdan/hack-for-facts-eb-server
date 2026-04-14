import { Type } from '@sinclair/typebox';
import { err, ok, type Result } from 'neverthrow';

import {
  BUDGET_DOCUMENT_INTERACTION_ID,
  DEBATE_REQUEST_INTERACTION_ID,
} from '@/common/campaign-user-interactions.js';
import {
  buildCampaignAdminInteractionStepLink,
  buildCampaignProvocariStepPath,
  getCampaignAdminInteractionConfig,
  getCampaignAdminReviewConfig,
  hasStartedLatestEntityInteraction,
  listReviewedInteractionCandidates,
  loadLatestEntityInteractionRow,
  loadReviewedInteractionCandidateByIdentity,
  type CampaignAdminInteractionConfig,
  type CampaignAdminInteractionRow,
  type CampaignAdminListCursor,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';
import {
  enqueueAdminReviewedInteractionNotification,
  getErrorMessage,
  type AdminReviewedInteractionNextStepLink,
  type ComposeJobScheduler,
  type DeliveryRepository,
  type ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';

import { createDatabaseError, type CampaignAdminNotificationError } from '../../core/errors.js';
import {
  ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
  ADMIN_REVIEWED_USER_INTERACTION_TEMPLATE_ID,
  ADMIN_REVIEWED_USER_INTERACTION_TRIGGER_ID,
  REVIEWED_INTERACTION_BULK_DEFAULT_LIMIT,
  REVIEWED_INTERACTION_BULK_MAX_LIMIT,
} from '../../core/reviewed-interaction.js';
import { runCampaignNotificationFamilyBulk } from '../../core/usecases/run-campaign-notification-family-bulk.js';
import { runCampaignNotificationFamilySingle } from '../../core/usecases/run-campaign-notification-family-single.js';
import { listSchemaFields } from '../shared/schema-field-descriptors.js';

import type {
  CampaignNotificationFamilyDefinition,
  CampaignNotificationFamilyExecutionOutcome,
  CampaignNotificationFamilyPlan,
} from '../../core/family-runner.js';
import type {
  CampaignNotificationTriggerDefinition,
  CampaignNotificationTriggerExecutionInput,
  CampaignNotificationTriggerBulkExecutionInput,
} from '../../core/ports.js';
import type { EntityRepository } from '@/modules/entity/index.js';

interface ReviewedInteractionTriggerDeps {
  learningProgressRepo: LearningProgressRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
  entityRepo: EntityRepository;
  platformBaseUrl: string;
}

const ReviewStatusSchema = Type.Union([Type.Literal('approved'), Type.Literal('rejected')]);

const ReviewedInteractionSingleTriggerSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const ReviewedInteractionBulkFiltersSchema = Type.Object(
  {
    reviewStatus: Type.Optional(ReviewStatusSchema),
    interactionId: Type.Optional(Type.String({ minLength: 1 })),
    interactionIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 })
    ),
    entityCui: Type.Optional(Type.String({ minLength: 1 })),
    userId: Type.Optional(Type.String({ minLength: 1 })),
    recordKey: Type.Optional(Type.String({ minLength: 1 })),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    submittedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    submittedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false }
);

const ReviewedInteractionBulkTriggerSchema = Type.Object(
  {
    filters: ReviewedInteractionBulkFiltersSchema,
    dryRun: Type.Optional(Type.Boolean()),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: REVIEWED_INTERACTION_BULK_MAX_LIMIT,
      })
    ),
  },
  { additionalProperties: false }
);

interface ReviewedInteractionCandidateIdentity {
  readonly userId: string;
  readonly recordKey: string;
}

interface ReviewedInteractionBulkFilters {
  readonly reviewStatus?: 'approved' | 'rejected';
  readonly interactionId?: string;
  readonly interactionIds?: readonly string[];
  readonly entityCui?: string;
  readonly userId?: string;
  readonly recordKey?: string;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly submittedAtFrom?: string;
  readonly submittedAtTo?: string;
}

interface ReviewedInteractionEnrichment {
  readonly interactionConfig: CampaignAdminInteractionConfig | null;
  readonly interactionLabel: string;
  readonly entityCui: string | null;
  readonly entityName: string | null;
  readonly nextStepLinks: readonly AdminReviewedInteractionNextStepLink[];
}

interface ReviewedInteractionQueuedPlan {
  readonly notificationInput: {
    readonly userId: string;
    readonly entityCui: string;
    readonly entityName: string;
    readonly recordKey: string;
    readonly interactionId: string;
    readonly interactionLabel: string;
    readonly reviewStatus: 'approved' | 'rejected';
    readonly reviewedAt: string;
    readonly feedbackText?: string;
    readonly nextStepLinks?: readonly AdminReviewedInteractionNextStepLink[];
  };
}

const parseTimestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const minTimestamp = (left: string, right: string): string => {
  const leftTime = parseTimestamp(left);
  const rightTime = parseTimestamp(right);
  if (leftTime === null || rightTime === null) {
    return left.localeCompare(right) <= 0 ? left : right;
  }

  return leftTime <= rightTime ? left : right;
};

const emptyIds = Object.freeze([]) as readonly string[];

const toSkippedOutcome = (
  reason: string,
  category: 'skipped' | 'ineligible' | 'not_replayable' | 'stale'
): CampaignNotificationFamilyExecutionOutcome => ({
  kind: 'skipped',
  category,
  reason,
  familyId: ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
  createdOutboxIds: emptyIds,
  reusedOutboxIds: emptyIds,
  queuedOutboxIds: emptyIds,
  enqueueFailedOutboxIds: emptyIds,
});

const trimOptionalText = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

const loadEntityName = async (
  entityRepo: EntityRepository,
  entityCui: string
): Promise<Result<string, CampaignAdminNotificationError>> => {
  const entityResult = await entityRepo.getById(entityCui);
  if (entityResult.isErr()) {
    return err(createDatabaseError('Failed to load entity for reviewed interaction.'));
  }

  const entityName = entityResult.value?.name.trim();
  return ok(entityName === undefined || entityName === '' ? entityCui : entityName);
};

const toAbsolutePlatformUrl = (platformBaseUrl: string, url: string): string => {
  try {
    return new URL(url, platformBaseUrl).toString();
  } catch {
    return url;
  }
};

const buildRetryLink = (
  platformBaseUrl: string,
  row: CampaignAdminInteractionRow,
  interactionConfig: CampaignAdminInteractionConfig | null
): AdminReviewedInteractionNextStepLink | null => {
  const url = buildCampaignAdminInteractionStepLink({
    record: row.record,
    interactionConfig,
  });
  if (url === null) {
    return null;
  }

  return {
    kind: 'retry_interaction',
    label: interactionConfig?.label ?? row.record.interactionId,
    url: toAbsolutePlatformUrl(platformBaseUrl, url),
    description: 'Revino la pas si retrimite interactiunea dupa corectii.',
  };
};

const buildPublicDebateStartLink = (input: {
  platformBaseUrl: string;
  entityCui: string;
  latestDebateRow: CampaignAdminInteractionRow | null;
  debateConfig: CampaignAdminInteractionConfig | null;
}): AdminReviewedInteractionNextStepLink | null => {
  if (input.debateConfig?.interactionStepLocation === null || input.debateConfig === null) {
    return null;
  }

  const url =
    input.latestDebateRow !== null
      ? buildCampaignAdminInteractionStepLink({
          record: input.latestDebateRow.record,
          interactionConfig: input.debateConfig,
        })
      : buildCampaignProvocariStepPath(input.entityCui, input.debateConfig.interactionStepLocation);

  if (url === null) {
    return null;
  }

  return {
    kind: 'start_public_debate_request',
    label: input.debateConfig.label ?? 'Cerere dezbatere publica',
    url: toAbsolutePlatformUrl(input.platformBaseUrl, url),
    description: 'Poti continua cu pasul de cerere pentru dezbatere publica.',
  };
};

const createAdminReviewedInteractionFamily = (
  deps: ReviewedInteractionTriggerDeps
): CampaignNotificationFamilyDefinition<
  ReviewedInteractionCandidateIdentity,
  ReviewedInteractionBulkFilters,
  CampaignAdminInteractionRow,
  ReviewedInteractionEnrichment,
  ReviewedInteractionQueuedPlan,
  CampaignAdminListCursor
> => ({
  familyId: ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
  campaignKey: 'funky',
  templateId: ADMIN_REVIEWED_USER_INTERACTION_TEMPLATE_ID,
  async loadSingleCandidate(input) {
    const candidateResult = await loadReviewedInteractionCandidateByIdentity(
      { repo: deps.learningProgressRepo },
      {
        campaignKey: 'funky',
        identity: input,
      }
    );

    if (candidateResult.isErr()) {
      return err(
        createDatabaseError(
          candidateResult.error.message,
          'retryable' in candidateResult.error ? candidateResult.error.retryable : false
        )
      );
    }

    return ok(candidateResult.value);
  },
  captureBulkWatermark() {
    return Promise.resolve(ok(new Date().toISOString()));
  },
  async loadBulkPage(input) {
    const updatedAtTo =
      input.filters.updatedAtTo !== undefined
        ? minTimestamp(input.filters.updatedAtTo, input.watermark)
        : input.watermark;

    const pageResult = await listReviewedInteractionCandidates(
      { repo: deps.learningProgressRepo },
      {
        campaignKey: 'funky',
        ...(input.filters.reviewStatus !== undefined
          ? { reviewStatus: input.filters.reviewStatus }
          : {}),
        reviewSource: 'campaign_admin_api',
        ...(input.filters.interactionId !== undefined
          ? { interactionId: input.filters.interactionId }
          : {}),
        ...(input.filters.interactionIds !== undefined
          ? { interactionIds: input.filters.interactionIds }
          : {}),
        ...(input.filters.entityCui !== undefined ? { entityCui: input.filters.entityCui } : {}),
        ...(input.filters.userId !== undefined ? { userId: input.filters.userId } : {}),
        ...(input.filters.recordKey !== undefined ? { recordKey: input.filters.recordKey } : {}),
        ...(input.filters.submittedAtFrom !== undefined
          ? { submittedAtFrom: input.filters.submittedAtFrom }
          : {}),
        ...(input.filters.submittedAtTo !== undefined
          ? { submittedAtTo: input.filters.submittedAtTo }
          : {}),
        ...(input.filters.updatedAtFrom !== undefined
          ? { updatedAtFrom: input.filters.updatedAtFrom }
          : {}),
        updatedAtTo,
        limit: input.pageLimit,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      }
    );

    if (pageResult.isErr()) {
      return err(
        createDatabaseError(
          pageResult.error.message,
          'retryable' in pageResult.error ? pageResult.error.retryable : false
        )
      );
    }

    return ok({
      items: pageResult.value.rows,
      nextCursor: pageResult.value.nextCursor,
      hasMore: pageResult.value.hasMore,
    });
  },
  async enrichCandidate(candidate) {
    const campaignConfig = getCampaignAdminReviewConfig('funky');
    const interactionConfig =
      campaignConfig === null
        ? null
        : getCampaignAdminInteractionConfig(campaignConfig, candidate.record.interactionId);
    const entityCui =
      candidate.record.scope.type === 'entity' ? candidate.record.scope.entityCui : null;
    const interactionLabel = interactionConfig?.label ?? candidate.record.interactionId;
    const nextStepLinks: AdminReviewedInteractionNextStepLink[] = [];

    let entityName: string | null = null;
    if (entityCui !== null) {
      const entityNameResult = await loadEntityName(deps.entityRepo, entityCui);
      if (entityNameResult.isErr()) {
        return err(entityNameResult.error);
      }
      entityName = entityNameResult.value;
    }

    const review = candidate.record.review;
    if (
      entityCui !== null &&
      review?.status === 'approved' &&
      candidate.record.interactionId === BUDGET_DOCUMENT_INTERACTION_ID
    ) {
      const latestDebateRowResult = await loadLatestEntityInteractionRow(
        { repo: deps.learningProgressRepo },
        {
          campaignKey: 'funky',
          userId: candidate.userId,
          entityCui,
          interactionId: DEBATE_REQUEST_INTERACTION_ID,
        }
      );
      if (latestDebateRowResult.isErr()) {
        return err(
          createDatabaseError(
            latestDebateRowResult.error.message,
            'retryable' in latestDebateRowResult.error
              ? latestDebateRowResult.error.retryable
              : false
          )
        );
      }

      if (!hasStartedLatestEntityInteraction(latestDebateRowResult.value)) {
        const debateConfig =
          campaignConfig === null
            ? null
            : getCampaignAdminInteractionConfig(campaignConfig, DEBATE_REQUEST_INTERACTION_ID);
        const publicDebateLink = buildPublicDebateStartLink({
          platformBaseUrl: deps.platformBaseUrl,
          entityCui,
          latestDebateRow: latestDebateRowResult.value,
          debateConfig,
        });
        if (publicDebateLink !== null) {
          nextStepLinks.push(publicDebateLink);
        }
      }
    }

    if (review?.status === 'rejected') {
      const retryLink = buildRetryLink(deps.platformBaseUrl, candidate, interactionConfig);
      if (retryLink !== null) {
        nextStepLinks.push(retryLink);
      }
    }

    return ok({
      interactionConfig,
      interactionLabel,
      entityCui,
      entityName,
      nextStepLinks,
    });
  },
  planCandidate(input): CampaignNotificationFamilyPlan<ReviewedInteractionQueuedPlan> {
    const { candidate, enrichment } = input;
    const review = candidate.record.review;

    if (
      candidate.record.scope.type !== 'entity' ||
      enrichment.entityCui === null ||
      enrichment.entityName === null
    ) {
      return {
        disposition: 'skip',
        reason: 'unsupported_scope',
      };
    }

    if (
      candidate.record.interactionId !== BUDGET_DOCUMENT_INTERACTION_ID &&
      candidate.record.interactionId !== DEBATE_REQUEST_INTERACTION_ID
    ) {
      return {
        disposition: 'skip',
        reason: 'unsupported_interaction',
      };
    }

    if (review === undefined || review === null) {
      return {
        disposition: 'skip',
        reason: 'not_admin_reviewed',
      };
    }

    if (
      review.reviewedAt === null ||
      (review.status !== 'approved' && review.status !== 'rejected') ||
      review.reviewSource !== 'campaign_admin_api'
    ) {
      return {
        disposition: 'skip',
        reason: 'not_admin_reviewed',
      };
    }

    if (
      candidate.record.interactionId === DEBATE_REQUEST_INTERACTION_ID &&
      review.status === 'approved'
    ) {
      return {
        disposition: 'delegate',
        reason: 'approved_public_debate_request',
        target: 'public_debate_request_dispatch',
      };
    }

    const feedbackText = trimOptionalText(review.feedbackText);

    return {
      disposition: 'queue',
      queuedPlan: {
        notificationInput: {
          userId: candidate.userId,
          entityCui: enrichment.entityCui,
          entityName: enrichment.entityName,
          recordKey: candidate.recordKey,
          interactionId: candidate.record.interactionId,
          interactionLabel: enrichment.interactionLabel,
          reviewStatus: review.status,
          reviewedAt: review.reviewedAt,
          ...(feedbackText !== undefined ? { feedbackText } : {}),
          ...(enrichment.nextStepLinks.length > 0
            ? { nextStepLinks: enrichment.nextStepLinks }
            : {}),
        },
      },
    };
  },
  async executePlan(input) {
    if (input.plan.disposition === 'skip') {
      return ok(toSkippedOutcome(input.plan.reason, 'skipped'));
    }

    if (input.plan.disposition === 'delegate') {
      return ok({
        kind: 'delegated',
        familyId: ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
        reason: input.plan.reason,
        target: input.plan.target,
        createdOutboxIds: emptyIds,
        reusedOutboxIds: emptyIds,
        queuedOutboxIds: emptyIds,
        enqueueFailedOutboxIds: emptyIds,
      });
    }

    const enqueueResult = await enqueueAdminReviewedInteractionNotification(
      {
        notificationsRepo: deps.extendedNotificationsRepo,
        deliveryRepo: deps.deliveryRepo,
        composeJobScheduler: deps.composeJobScheduler,
      },
      {
        runId: `campaign-admin-${ADMIN_REVIEWED_USER_INTERACTION_TRIGGER_ID}-${String(Date.now())}`,
        dryRun: input.context.dryRun,
        triggerSource: input.context.triggerSource,
        triggeredByUserId: input.context.actorUserId,
        ...input.plan.queuedPlan.notificationInput,
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

    const result = enqueueResult.value;

    if (result.status === 'skipped' && result.reason === 'ineligible_now') {
      return ok(toSkippedOutcome(result.reason, 'ineligible'));
    }

    if (result.status === 'skipped' && result.reason === 'existing_not_replayable') {
      return ok(toSkippedOutcome(result.reason, 'not_replayable'));
    }

    if (result.status === 'skipped' && result.reason === 'stale_occurrence') {
      return ok(toSkippedOutcome(result.reason, 'stale'));
    }

    if (
      result.status === 'skipped' &&
      (result.reason === 'existing_sent' || result.reason === 'existing_pending')
    ) {
      return ok(toSkippedOutcome(result.reason, 'skipped'));
    }

    return ok({
      kind: 'prepared',
      familyId: ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
      reason: 'eligible_now',
      dryRun: input.context.dryRun,
      source: result.source ?? 'created',
      createdOutboxIds:
        result.source === 'created' && result.outboxId !== undefined ? [result.outboxId] : emptyIds,
      reusedOutboxIds:
        result.source === 'reused' && result.outboxId !== undefined ? [result.outboxId] : emptyIds,
      queuedOutboxIds:
        (input.context.dryRun || result.status === 'queued') && result.outboxId !== undefined
          ? [result.outboxId]
          : emptyIds,
      enqueueFailedOutboxIds:
        result.reason === 'enqueue_failed' && result.outboxId !== undefined
          ? [result.outboxId]
          : emptyIds,
    });
  },
});

export const makeAdminReviewedInteractionTriggerDefinition = (
  deps: ReviewedInteractionTriggerDeps
): CampaignNotificationTriggerDefinition => {
  const family = createAdminReviewedInteractionFamily(deps);

  return {
    triggerId: ADMIN_REVIEWED_USER_INTERACTION_TRIGGER_ID,
    campaignKey: 'funky',
    familyId: ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
    templateId: ADMIN_REVIEWED_USER_INTERACTION_TEMPLATE_ID,
    description:
      'Manually replay or bulk-run reviewed interaction notifications; admin review submission does not trigger this endpoint by default.',
    inputSchema: ReviewedInteractionSingleTriggerSchema,
    inputFields: listSchemaFields(ReviewedInteractionSingleTriggerSchema),
    targetKind: 'user_interaction',
    capabilities: {
      supportsSingleExecution: true,
      supportsBulkExecution: true,
      supportsDryRun: true,
      defaultLimit: REVIEWED_INTERACTION_BULK_DEFAULT_LIMIT,
      maxLimit: REVIEWED_INTERACTION_BULK_MAX_LIMIT,
      bulkInputFields: listSchemaFields(ReviewedInteractionBulkFiltersSchema),
    },
    bulkInputSchema: ReviewedInteractionBulkTriggerSchema,
    async execute(input: CampaignNotificationTriggerExecutionInput) {
      const payload = input.payload as ReviewedInteractionCandidateIdentity;

      return runCampaignNotificationFamilySingle(family, {
        candidate: payload,
        context: {
          campaignKey: input.campaignKey,
          actorUserId: input.actorUserId,
          triggerSource: 'campaign_admin',
          dryRun: false,
        },
      });
    },
    async executeBulk(input: CampaignNotificationTriggerBulkExecutionInput) {
      const payload = input.payload as {
        filters: ReviewedInteractionBulkFilters;
        dryRun?: boolean;
        limit?: number;
      };

      return runCampaignNotificationFamilyBulk(family, {
        filters: payload.filters,
        limit: payload.limit ?? REVIEWED_INTERACTION_BULK_DEFAULT_LIMIT,
        context: {
          campaignKey: input.campaignKey,
          actorUserId: input.actorUserId,
          triggerSource: 'campaign_admin',
          dryRun: payload.dryRun === true,
        },
      });
    },
  };
};
