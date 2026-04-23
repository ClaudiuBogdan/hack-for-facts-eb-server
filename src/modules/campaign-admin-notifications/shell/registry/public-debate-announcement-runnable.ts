import { createHash, randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok } from 'neverthrow';

import {
  type CampaignEntityConfigListCursor,
  getCampaignEntityConfig,
  listPublicDebateCampaignEntityConfigs,
  type CampaignEntityConfigPublicDebate,
} from '@/modules/campaign-entity-config/index.js';
import { TEMPLATE_VERSION } from '@/modules/email-templates/index.js';
import {
  enqueuePublicDebateAnnouncementNotification,
  getErrorMessage,
  isPublicDebateAnnouncementAfterTriggerTime,
  type EnqueuePublicDebateAnnouncementNotificationResult,
} from '@/modules/notification-delivery/index.js';

import { createDatabaseError, createValidationError } from '../../core/errors.js';

import type { ReviewedInteractionTriggerDeps } from './admin-reviewed-interaction-trigger.js';
import type { CampaignNotificationRunnableTemplateDefinition } from '../../core/ports.js';
import type {
  CampaignNotificationRunnablePlanRow,
  CampaignNotificationRunnablePlanSummary,
  CampaignNotificationStoredPlanRow,
} from '../../core/types.js';

const RUNNABLE_ID = 'public_debate_announcement';
const TEMPLATE_ID = 'public_debate_announcement';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_PLAN_ROW_COUNT = 500;
const CONFIG_FETCH_PAGE_SIZE = 100;
const INTERACTION_ID = 'public_debate_announcement';
const INTERACTION_LABEL = 'Public debate announcement';

const PublicDebateAnnouncementSelectorsSchema = Type.Object(
  {
    entityCui: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const PublicDebateAnnouncementFiltersSchema = Type.Object(
  {
    hasPublicDebate: Type.Optional(Type.Boolean()),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false }
);

interface PublicDebateAnnouncementSelectors {
  readonly entityCui?: string;
}

interface PublicDebateAnnouncementFilters {
  readonly hasPublicDebate?: boolean;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
}

interface PublicDebateAnnouncementExecutionData {
  readonly kind: 'public_debate_announcement';
  readonly userId: string;
  readonly entityCui: string;
  readonly announcementFingerprint: string;
  readonly configUpdatedAt: string;
}

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

const buildAnnouncementFingerprint = (publicDebate: CampaignEntityConfigPublicDebate): string => {
  const canonical = [
    publicDebate.date,
    publicDebate.time,
    publicDebate.location,
    publicDebate.announcement_link,
    publicDebate.online_participation_link ?? '',
    publicDebate.description ?? '',
  ].join('|');

  return createHash('sha256').update(canonical).digest('hex');
};

const toStatusMessage = (publicDebate: CampaignEntityConfigPublicDebate): string => {
  const details = [`${publicDebate.date} at ${publicDebate.time}`, publicDebate.location];
  if (publicDebate.online_participation_link !== undefined) {
    details.push('online participation available');
  }

  return details.join(' · ');
};

const basePreviewRow = (input: {
  userId: string;
  entityCui: string;
  entityName: string | null;
  announcementFingerprint: string;
  publicDebate: CampaignEntityConfigPublicDebate;
  status: CampaignNotificationRunnablePlanRow['status'];
  reasonCode: string;
  hasExistingDelivery: boolean;
  existingDeliveryStatus: string | null;
  sendMode: CampaignNotificationRunnablePlanRow['sendMode'];
}): CampaignNotificationRunnablePlanRow => {
  return {
    rowKey: `${input.userId}:${input.entityCui}:${input.announcementFingerprint}`,
    userId: input.userId,
    entityCui: input.entityCui,
    entityName: input.entityName,
    recordKey: `internal:entity-config::${input.entityCui}`,
    interactionId: INTERACTION_ID,
    interactionLabel: INTERACTION_LABEL,
    reviewStatus: null,
    reviewedAt: null,
    status: input.status,
    reasonCode: input.reasonCode,
    statusMessage: toStatusMessage(input.publicDebate),
    hasExistingDelivery: input.hasExistingDelivery,
    existingDeliveryStatus: input.existingDeliveryStatus,
    sendMode: input.sendMode,
  };
};

const toStoredRow = (input: {
  evaluation: EnqueuePublicDebateAnnouncementNotificationResult;
  userId: string;
  entityCui: string;
  entityName: string | null;
  publicDebate: CampaignEntityConfigPublicDebate;
  announcementFingerprint: string;
  configUpdatedAt: string;
}): CampaignNotificationStoredPlanRow => {
  if (input.evaluation.reason === 'eligible_now') {
    return {
      preview: basePreviewRow({
        userId: input.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        publicDebate: input.publicDebate,
        announcementFingerprint: input.announcementFingerprint,
        status: 'will_send',
        reasonCode: input.evaluation.reason,
        hasExistingDelivery: false,
        existingDeliveryStatus: null,
        sendMode: 'create',
      }),
      executionData: {
        kind: 'public_debate_announcement',
        userId: input.userId,
        entityCui: input.entityCui,
        announcementFingerprint: input.announcementFingerprint,
        configUpdatedAt: input.configUpdatedAt,
      },
    };
  }

  if (input.evaluation.reason === 'existing_failed_transient') {
    return {
      preview: basePreviewRow({
        userId: input.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        publicDebate: input.publicDebate,
        announcementFingerprint: input.announcementFingerprint,
        status: 'will_send',
        reasonCode: input.evaluation.reason,
        hasExistingDelivery: true,
        existingDeliveryStatus: input.evaluation.outboxStatus ?? 'failed_transient',
        sendMode: 'reuse_claimable',
      }),
      executionData: {
        kind: 'public_debate_announcement',
        userId: input.userId,
        entityCui: input.entityCui,
        announcementFingerprint: input.announcementFingerprint,
        configUpdatedAt: input.configUpdatedAt,
      },
    };
  }

  if (input.evaluation.reason === 'existing_pending') {
    return {
      preview: basePreviewRow({
        userId: input.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        publicDebate: input.publicDebate,
        announcementFingerprint: input.announcementFingerprint,
        status: 'already_pending',
        reasonCode: input.evaluation.reason,
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
        userId: input.userId,
        entityCui: input.entityCui,
        entityName: input.entityName,
        publicDebate: input.publicDebate,
        announcementFingerprint: input.announcementFingerprint,
        status: 'already_sent',
        reasonCode: input.evaluation.reason,
        hasExistingDelivery: true,
        existingDeliveryStatus: input.evaluation.outboxStatus ?? null,
        sendMode: null,
      }),
      executionData: null,
    };
  }

  return {
    preview: basePreviewRow({
      userId: input.userId,
      entityCui: input.entityCui,
      entityName: input.entityName,
      publicDebate: input.publicDebate,
      announcementFingerprint: input.announcementFingerprint,
      status: 'ineligible',
      reasonCode:
        input.evaluation.reason === 'ineligible_now'
          ? input.evaluation.eligibility.reason
          : input.evaluation.reason,
      hasExistingDelivery: false,
      existingDeliveryStatus: null,
      sendMode: null,
    }),
    executionData: null,
  };
};

const parseExecutionData = (
  value: Record<string, unknown> | null
): PublicDebateAnnouncementExecutionData | null => {
  if (value === null) {
    return null;
  }

  if (
    value['kind'] !== 'public_debate_announcement' ||
    typeof value['userId'] !== 'string' ||
    typeof value['entityCui'] !== 'string' ||
    typeof value['announcementFingerprint'] !== 'string' ||
    typeof value['configUpdatedAt'] !== 'string'
  ) {
    return null;
  }

  return value as unknown as PublicDebateAnnouncementExecutionData;
};

const mapLiveSendOutcome = (
  result: EnqueuePublicDebateAnnouncementNotificationResult
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

  return 'already_sent';
};

export const makePublicDebateAnnouncementRunnableDefinition = (
  deps: ReviewedInteractionTriggerDeps
): CampaignNotificationRunnableTemplateDefinition => {
  return {
    runnableId: RUNNABLE_ID,
    campaignKey: 'funky',
    templateId: TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    description:
      'Dry-run and send config-driven public debate announcement notifications from the admin surface using stored plans.',
    selectorSchema: PublicDebateAnnouncementSelectorsSchema,
    filterSchema: PublicDebateAnnouncementFiltersSchema,
    selectors: [{ name: 'entityCui', type: 'string', required: false }],
    filters: [
      { name: 'hasPublicDebate', type: 'boolean', required: false },
      { name: 'updatedAtFrom', type: 'string', required: false },
      { name: 'updatedAtTo', type: 'string', required: false },
    ],
    targetKind: 'entity_config',
    dryRunRequired: true,
    maxPlanRowCount: MAX_PLAN_ROW_COUNT,
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
    async dryRun(input) {
      if (
        !Value.Check(PublicDebateAnnouncementSelectorsSchema, input.selectors) ||
        !Value.Check(PublicDebateAnnouncementFiltersSchema, input.filters)
      ) {
        return err(createValidationError('Invalid public debate announcement runnable payload.'));
      }

      const selectors = input.selectors as PublicDebateAnnouncementSelectors;
      const filters = input.filters as PublicDebateAnnouncementFilters;
      const triggerTime = new Date();
      const watermark = triggerTime.toISOString();

      if (filters.hasPublicDebate === false) {
        return ok({
          watermark,
          summary: createEmptySummary(),
          rows: [],
        });
      }

      const rows: CampaignNotificationStoredPlanRow[] = [];
      let summary = createEmptySummary();
      let cursor: CampaignEntityConfigListCursor | undefined;

      for (;;) {
        const pageResult = await listPublicDebateCampaignEntityConfigs(
          {
            learningProgressRepo: deps.learningProgressRepo,
            entityRepo: deps.entityRepo,
          },
          {
            campaignKey: 'funky',
            ...(selectors.entityCui !== undefined ? { entityCui: selectors.entityCui } : {}),
            ...(filters.updatedAtFrom !== undefined
              ? { updatedAtFrom: filters.updatedAtFrom }
              : {}),
            ...(filters.updatedAtTo !== undefined ? { updatedAtTo: filters.updatedAtTo } : {}),
            limit: CONFIG_FETCH_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor } : {}),
          }
        );
        if (pageResult.isErr()) {
          return err(pageResult.error);
        }

        for (const item of pageResult.value.items) {
          const publicDebate = item.values.public_debate;
          if (publicDebate === null || item.updatedAt === null) {
            const storedRow: CampaignNotificationStoredPlanRow = {
              preview: {
                rowKey: `${item.entityCui}:missing`,
                userId: 'unknown',
                entityCui: item.entityCui,
                entityName: item.entityName,
                recordKey: `internal:entity-config::${item.entityCui}`,
                interactionId: INTERACTION_ID,
                interactionLabel: INTERACTION_LABEL,
                reviewStatus: null,
                reviewedAt: null,
                status: 'missing_data',
                reasonCode: 'missing_data',
                statusMessage: 'The public debate announcement payload is missing required data.',
                hasExistingDelivery: false,
                existingDeliveryStatus: null,
                sendMode: null,
              },
              executionData: null,
            };
            rows.push(storedRow);
            summary = addSummaryRow(summary, storedRow.preview.status);
            continue;
          }

          if (
            !isPublicDebateAnnouncementAfterTriggerTime({
              publicDebate,
              triggerTime,
            })
          ) {
            continue;
          }

          const announcementFingerprint = buildAnnouncementFingerprint(publicDebate);
          const notificationsResult =
            await deps.extendedNotificationsRepo.findActiveByTypeAndEntity(
              'funky:notification:entity_updates',
              item.entityCui
            );
          if (notificationsResult.isErr()) {
            return err(
              createDatabaseError(
                getErrorMessage(notificationsResult.error),
                'retryable' in notificationsResult.error
                  ? notificationsResult.error.retryable
                  : false
              )
            );
          }

          for (const notification of notificationsResult.value) {
            const dryRunResult = await enqueuePublicDebateAnnouncementNotification(
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
                userId: notification.userId,
                entityCui: item.entityCui,
                entityName: item.entityName ?? item.entityCui,
                publicDebate,
                announcementFingerprint,
                configUpdatedAt: item.updatedAt,
                notificationTriggerTime: triggerTime,
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

            const storedRow = toStoredRow({
              evaluation: dryRunResult.value,
              userId: notification.userId,
              entityCui: item.entityCui,
              entityName: item.entityName,
              publicDebate,
              announcementFingerprint,
              configUpdatedAt: item.updatedAt,
            });
            rows.push(storedRow);
            summary = addSummaryRow(summary, storedRow.preview.status);

            if (rows.length > MAX_PLAN_ROW_COUNT) {
              return err(
                createValidationError(
                  `Dry run exceeds the ${String(MAX_PLAN_ROW_COUNT)} row safety cap. Narrow selectors or filters.`
                )
              );
            }
          }
        }

        if (!pageResult.value.hasMore || pageResult.value.nextCursor === null) {
          break;
        }

        cursor = pageResult.value.nextCursor;
      }

      return ok({
        watermark,
        summary,
        rows,
      });
    },
    async executeStoredRow(input) {
      const executionData = parseExecutionData(input.row.executionData);
      if (executionData === null) {
        return ok({ outcome: 'missing_data' as const });
      }

      const configResult = await getCampaignEntityConfig(
        {
          learningProgressRepo: deps.learningProgressRepo,
          entityRepo: deps.entityRepo,
        },
        {
          campaignKey: 'funky',
          entityCui: executionData.entityCui,
        }
      );
      if (configResult.isErr()) {
        return err(configResult.error);
      }

      const publicDebate = configResult.value.values.public_debate;
      if (publicDebate === null || configResult.value.updatedAt === null) {
        return ok({ outcome: 'missing_data' as const });
      }

      const liveFingerprint = buildAnnouncementFingerprint(publicDebate);
      if (liveFingerprint !== executionData.announcementFingerprint) {
        return ok({ outcome: 'missing_data' as const });
      }

      const triggerTime = new Date();
      if (
        !isPublicDebateAnnouncementAfterTriggerTime({
          publicDebate,
          triggerTime,
        })
      ) {
        return ok({ outcome: 'ineligible' as const });
      }

      const enqueueResult = await enqueuePublicDebateAnnouncementNotification(
        {
          notificationsRepo: deps.extendedNotificationsRepo,
          deliveryRepo: deps.deliveryRepo,
          composeJobScheduler: deps.composeJobScheduler,
        },
        {
          runId: `campaign-admin-runnable-send-${randomUUID()}`,
          triggerSource: 'campaign_admin',
          triggeredByUserId: input.actorUserId,
          userId: executionData.userId,
          entityCui: executionData.entityCui,
          entityName: configResult.value.entityName ?? executionData.entityCui,
          publicDebate,
          announcementFingerprint: executionData.announcementFingerprint,
          configUpdatedAt: configResult.value.updatedAt,
          notificationTriggerTime: triggerTime,
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
