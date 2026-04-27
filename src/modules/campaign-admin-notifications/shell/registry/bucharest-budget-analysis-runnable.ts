import { createHash, randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok } from 'neverthrow';

import { TEMPLATE_VERSION } from '@/modules/email-templates/index.js';
import {
  BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
  BUCHAREST_BUDGET_ANALYSIS_ENTITY_NAME,
  BUCHAREST_BUDGET_ANALYSIS_ID,
  BUCHAREST_BUDGET_ANALYSIS_TEMPLATE_ID,
  enqueueBucharestBudgetAnalysisNotification,
  getErrorMessage,
  type EnqueueBucharestBudgetAnalysisNotificationResult,
} from '@/modules/notification-delivery/index.js';

import { createDatabaseError, createValidationError } from '../../core/errors.js';

import type { ReviewedInteractionTriggerDeps } from './admin-reviewed-interaction-trigger.js';
import type { CampaignNotificationRunnableTemplateDefinition } from '../../core/ports.js';
import type {
  CampaignNotificationRunnablePlanRow,
  CampaignNotificationRunnablePlanSummary,
  CampaignNotificationStoredPlanRow,
} from '../../core/types.js';

const RUNNABLE_ID = 'bucharest_budget_analysis';
const TEMPLATE_ID = BUCHAREST_BUDGET_ANALYSIS_TEMPLATE_ID;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_PLAN_ROW_COUNT = 500;
const INTERACTION_ID = 'bucharest_budget_analysis';
const INTERACTION_LABEL = 'Bucharest budget analysis';

const BucharestBudgetAnalysisSelectorsSchema = Type.Object(
  {
    entityCui: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const BucharestBudgetAnalysisFiltersSchema = Type.Object({}, { additionalProperties: false });

interface BucharestBudgetAnalysisSelectors {
  readonly entityCui?: string;
}

interface BucharestBudgetAnalysisExecutionData {
  readonly kind: 'bucharest_budget_analysis';
  readonly userId: string;
  readonly entityCui: typeof BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI;
  readonly analysisFingerprint: string;
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

export const buildBucharestBudgetAnalysisFingerprint = (): string => {
  return createHash('sha256')
    .update(`${BUCHAREST_BUDGET_ANALYSIS_ID}:${BUCHAREST_BUDGET_ANALYSIS_TEMPLATE_ID}`)
    .digest('hex');
};

const basePreviewRow = (input: {
  userId: string;
  analysisFingerprint: string;
  status: CampaignNotificationRunnablePlanRow['status'];
  reasonCode: string;
  hasExistingDelivery: boolean;
  existingDeliveryStatus: string | null;
  sendMode: CampaignNotificationRunnablePlanRow['sendMode'];
}): CampaignNotificationRunnablePlanRow => {
  return {
    rowKey: `${input.userId}:${BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI}:${input.analysisFingerprint}`,
    userId: input.userId,
    entityCui: BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
    entityName: BUCHAREST_BUDGET_ANALYSIS_ENTITY_NAME,
    recordKey: `internal:entity-config::${BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI}`,
    interactionId: INTERACTION_ID,
    interactionLabel: INTERACTION_LABEL,
    reviewStatus: null,
    reviewedAt: null,
    status: input.status,
    reasonCode: input.reasonCode,
    statusMessage: 'Analiză buget local Primăria Municipiului București 2026',
    hasExistingDelivery: input.hasExistingDelivery,
    existingDeliveryStatus: input.existingDeliveryStatus,
    sendMode: input.sendMode,
  };
};

const toStoredRow = (input: {
  evaluation: EnqueueBucharestBudgetAnalysisNotificationResult;
  userId: string;
  analysisFingerprint: string;
}): CampaignNotificationStoredPlanRow => {
  if (input.evaluation.reason === 'eligible_now') {
    return {
      preview: basePreviewRow({
        userId: input.userId,
        analysisFingerprint: input.analysisFingerprint,
        status: 'will_send',
        reasonCode: input.evaluation.reason,
        hasExistingDelivery: false,
        existingDeliveryStatus: null,
        sendMode: 'create',
      }),
      executionData: {
        kind: 'bucharest_budget_analysis',
        userId: input.userId,
        entityCui: BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
        analysisFingerprint: input.analysisFingerprint,
      },
    };
  }

  if (input.evaluation.reason === 'existing_failed_transient') {
    return {
      preview: basePreviewRow({
        userId: input.userId,
        analysisFingerprint: input.analysisFingerprint,
        status: 'will_send',
        reasonCode: input.evaluation.reason,
        hasExistingDelivery: true,
        existingDeliveryStatus: input.evaluation.outboxStatus ?? 'failed_transient',
        sendMode: 'reuse_claimable',
      }),
      executionData: {
        kind: 'bucharest_budget_analysis',
        userId: input.userId,
        entityCui: BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
        analysisFingerprint: input.analysisFingerprint,
      },
    };
  }

  if (input.evaluation.reason === 'existing_pending') {
    return {
      preview: basePreviewRow({
        userId: input.userId,
        analysisFingerprint: input.analysisFingerprint,
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
        analysisFingerprint: input.analysisFingerprint,
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
      analysisFingerprint: input.analysisFingerprint,
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
): BucharestBudgetAnalysisExecutionData | null => {
  if (value === null) {
    return null;
  }

  if (
    value['kind'] !== 'bucharest_budget_analysis' ||
    typeof value['userId'] !== 'string' ||
    value['entityCui'] !== BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI ||
    typeof value['analysisFingerprint'] !== 'string'
  ) {
    return null;
  }

  return value as unknown as BucharestBudgetAnalysisExecutionData;
};

const mapLiveSendOutcome = (
  result: EnqueueBucharestBudgetAnalysisNotificationResult
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

export const makeBucharestBudgetAnalysisRunnableDefinition = (
  deps: ReviewedInteractionTriggerDeps
): CampaignNotificationRunnableTemplateDefinition => {
  return {
    runnableId: RUNNABLE_ID,
    campaignKey: 'funky',
    templateId: TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    description:
      'Dry-run and send the Bucharest-only Funky PMB 2026 budget analysis notification to entity subscribers.',
    selectorSchema: BucharestBudgetAnalysisSelectorsSchema,
    filterSchema: BucharestBudgetAnalysisFiltersSchema,
    selectors: [{ name: 'entityCui', type: 'string', required: false }],
    filters: [],
    targetKind: 'entity_subscription',
    dryRunRequired: true,
    maxPlanRowCount: MAX_PLAN_ROW_COUNT,
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
    async dryRun(input) {
      if (
        !Value.Check(BucharestBudgetAnalysisSelectorsSchema, input.selectors) ||
        !Value.Check(BucharestBudgetAnalysisFiltersSchema, input.filters)
      ) {
        return err(createValidationError('Invalid Bucharest budget analysis runnable payload.'));
      }

      const selectors = input.selectors as BucharestBudgetAnalysisSelectors;
      if (
        selectors.entityCui !== undefined &&
        selectors.entityCui !== BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI
      ) {
        return err(
          createValidationError(
            `Bucharest budget analysis can only target CUI ${BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI}.`
          )
        );
      }

      const watermark = new Date().toISOString();
      const analysisFingerprint = buildBucharestBudgetAnalysisFingerprint();
      const notificationsResult = await deps.extendedNotificationsRepo.findActiveByTypeAndEntity(
        'funky:notification:entity_updates',
        BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI
      );
      if (notificationsResult.isErr()) {
        return err(
          createDatabaseError(
            getErrorMessage(notificationsResult.error),
            'retryable' in notificationsResult.error ? notificationsResult.error.retryable : false
          )
        );
      }

      const rows: CampaignNotificationStoredPlanRow[] = [];
      let summary = createEmptySummary();

      for (const notification of notificationsResult.value) {
        const dryRunResult = await enqueueBucharestBudgetAnalysisNotification(
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
            analysisFingerprint,
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
          analysisFingerprint,
        });
        rows.push(storedRow);
        summary = addSummaryRow(summary, storedRow.preview.status);

        if (rows.length > MAX_PLAN_ROW_COUNT) {
          return err(
            createValidationError(
              `Dry run exceeds the ${String(MAX_PLAN_ROW_COUNT)} row safety cap.`
            )
          );
        }
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

      const liveFingerprint = buildBucharestBudgetAnalysisFingerprint();
      if (liveFingerprint !== executionData.analysisFingerprint) {
        return ok({ outcome: 'missing_data' as const });
      }

      const enqueueResult = await enqueueBucharestBudgetAnalysisNotification(
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
          analysisFingerprint: executionData.analysisFingerprint,
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
