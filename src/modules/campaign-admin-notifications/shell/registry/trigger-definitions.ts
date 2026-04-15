import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_CAMPAIGN_KEY,
  FUNKY_PROGRESS_TERMS_ACCEPTED_PREFIX,
} from '@/common/campaign-keys.js';
import {
  deriveCurrentPlatformSendSnapshot,
  type InstitutionCorrespondenceRepository,
} from '@/modules/institution-correspondence/index.js';
import {
  enqueuePublicDebateEntityUpdateNotifications,
  enqueuePublicDebateTermsAcceptedNotifications,
  type ComposeJobScheduler,
  type DeliveryRepository,
  type EnqueuePublicDebateTermsAcceptedNotificationsResult,
  type ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  sha256Hasher,
  type NotificationsRepository,
} from '@/modules/notifications/index.js';

import { makeAdminReviewedInteractionTriggerDefinition } from './admin-reviewed-interaction-trigger.js';
import { createDatabaseError, type CampaignAdminNotificationError } from '../../core/errors.js';
import { listSchemaFields } from '../shared/schema-field-descriptors.js';

import type {
  CampaignNotificationTriggerDefinition,
  CampaignNotificationTriggerExecutionInput,
  CampaignNotificationTriggerRegistry,
} from '../../core/ports.js';
import type { CampaignNotificationTriggerExecutionResult } from '../../core/types.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { LearningProgressRepository } from '@/modules/learning-progress/index.js';

interface TriggerRegistryDeps {
  learningProgressRepo: LearningProgressRepository;
  notificationsRepo: NotificationsRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
  entityRepo: EntityRepository;
  correspondenceRepo: InstitutionCorrespondenceRepository;
  platformBaseUrl: string;
}

const TermsAcceptedTriggerSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    entityCui: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const ThreadTriggerSchema = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const buildRunId = (triggerId: string): string => {
  return `campaign-admin-${triggerId}-${randomUUID()}`;
};

const buildTermsAcceptedSourceEventId = (triggerId: string, runId: string): string => {
  return `campaign-admin:${triggerId}:${runId}`;
};

const loadEntityName = async (
  entityRepo: EntityRepository,
  entityCui: string
): Promise<Result<string, CampaignAdminNotificationError>> => {
  const entityResult = await entityRepo.getById(entityCui);
  if (entityResult.isErr()) {
    return err(createDatabaseError('Failed to load entity for campaign notification trigger.'));
  }

  const entityName = entityResult.value?.name;
  return ok(entityName !== undefined && entityName.trim() !== '' ? entityName : entityCui);
};

const loadSelectedEntityNames = async (
  deps: Pick<TriggerRegistryDeps, 'notificationsRepo' | 'entityRepo'>,
  input: {
    userId: string;
    currentEntityCui: string;
    currentEntityName: string;
  }
): Promise<Result<string[] | undefined, CampaignAdminNotificationError>> => {
  const notificationsResult = await deps.notificationsRepo.findByUserId(input.userId, true);
  if (notificationsResult.isErr()) {
    return err(createDatabaseError('Failed to load active campaign subscriptions.'));
  }

  const additionalEntityCuis = notificationsResult.value.flatMap((notification) => {
    if (
      notification.notificationType !== 'funky:notification:entity_updates' ||
      notification.entityCui === null ||
      notification.entityCui === input.currentEntityCui
    ) {
      return [];
    }

    return [notification.entityCui];
  });

  const seen = new Set<string>([input.currentEntityCui]);
  const entityNames = [input.currentEntityName];

  for (const entityCui of additionalEntityCuis) {
    if (seen.has(entityCui)) {
      continue;
    }

    seen.add(entityCui);
    const entityResult = await deps.entityRepo.getById(entityCui);
    if (entityResult.isErr()) {
      entityNames.push(entityCui);
      continue;
    }

    const entityName = entityResult.value?.name;
    entityNames.push(entityName !== undefined && entityName.trim() !== '' ? entityName : entityCui);
  }

  return ok(entityNames);
};

const loadTermsAcceptedContext = async (
  deps: Pick<TriggerRegistryDeps, 'learningProgressRepo' | 'notificationsRepo' | 'entityRepo'>,
  input: {
    userId: string;
    entityCui: string;
  }
): Promise<
  Result<
    | {
        status: 'ready';
        userId: string;
        entityCui: string;
        entityName: string;
        acceptedTermsAt: string;
        globalPreferenceId: string;
        globalPreferenceActive: boolean;
        entitySubscriptionId: string;
        entitySubscriptionActive: boolean;
        selectedEntities?: string[];
      }
    | {
        status: 'missing_terms_acceptance';
      },
    CampaignAdminNotificationError
  >
> => {
  const recordKey = `${FUNKY_PROGRESS_TERMS_ACCEPTED_PREFIX}${input.entityCui}`;
  const recordResult = await deps.learningProgressRepo.getRecord(input.userId, recordKey);
  if (recordResult.isErr()) {
    return err(createDatabaseError('Failed to load terms-accepted record.'));
  }

  const recordRow = recordResult.value;
  const payload = recordRow?.record.value;
  if (recordRow === null || payload?.kind !== 'json') {
    return ok({ status: 'missing_terms_acceptance' });
  }

  const acceptedTermsAt =
    typeof payload.json.value['acceptedTermsAt'] === 'string'
      ? payload.json.value['acceptedTermsAt']
      : null;
  if (acceptedTermsAt === null || Number.isNaN(Date.parse(acceptedTermsAt))) {
    return ok({ status: 'missing_terms_acceptance' });
  }

  const entityNameResult = await loadEntityName(deps.entityRepo, input.entityCui);
  if (entityNameResult.isErr()) {
    return err(entityNameResult.error);
  }

  const subscriptionsResult = await ensurePublicDebateAutoSubscriptions(
    {
      notificationsRepo: deps.notificationsRepo,
      hasher: sha256Hasher,
    },
    {
      userId: input.userId,
      entityCui: input.entityCui,
    }
  );
  if (subscriptionsResult.isErr()) {
    return err(createDatabaseError('Failed to ensure campaign notification subscriptions.'));
  }

  const selectedEntitiesResult = await loadSelectedEntityNames(
    {
      notificationsRepo: deps.notificationsRepo,
      entityRepo: deps.entityRepo,
    },
    {
      userId: input.userId,
      currentEntityCui: input.entityCui,
      currentEntityName: entityNameResult.value,
    }
  );
  if (selectedEntitiesResult.isErr()) {
    return err(selectedEntitiesResult.error);
  }

  return ok({
    status: 'ready',
    userId: input.userId,
    entityCui: input.entityCui,
    entityName: entityNameResult.value,
    acceptedTermsAt,
    globalPreferenceId: subscriptionsResult.value.globalPreference.id,
    globalPreferenceActive: subscriptionsResult.value.globalPreference.isActive,
    entitySubscriptionId: subscriptionsResult.value.entitySubscription.id,
    entitySubscriptionActive: subscriptionsResult.value.entitySubscription.isActive,
    ...(selectedEntitiesResult.value !== undefined
      ? { selectedEntities: selectedEntitiesResult.value }
      : {}),
  });
};

const toTermsAcceptedExecutionResult = (
  templateId: 'public_debate_campaign_welcome' | 'public_debate_entity_subscription',
  result: EnqueuePublicDebateTermsAcceptedNotificationsResult
): CampaignNotificationTriggerExecutionResult => {
  if (result.status === 'skipped_scope_inactive') {
    return {
      status: 'skipped',
      reason: 'scope_inactive',
      createdOutboxIds: [],
      reusedOutboxIds: [],
      queuedOutboxIds: [],
      enqueueFailedOutboxIds: [],
    };
  }

  if (result.status === 'skipped_global_unsubscribe') {
    return {
      status: 'skipped',
      reason: 'global_unsubscribe',
      createdOutboxIds: [],
      reusedOutboxIds: [],
      queuedOutboxIds: [],
      enqueueFailedOutboxIds: [],
    };
  }

  const outboxId = result.outbox?.id;
  const createdOutboxIds = result.created && outboxId !== undefined ? [outboxId] : [];
  const reusedOutboxIds = !result.created && outboxId !== undefined ? [outboxId] : [];
  const queuedOutboxIds =
    result.requeued || result.created ? (outboxId !== undefined ? [outboxId] : []) : [];

  if (!result.created && !result.requeued) {
    return {
      status: 'skipped',
      reason:
        templateId === 'public_debate_campaign_welcome'
          ? 'welcome_already_processed'
          : 'entity_subscription_already_processed',
      createdOutboxIds,
      reusedOutboxIds,
      queuedOutboxIds: [],
      enqueueFailedOutboxIds: [],
    };
  }

  return {
    status: 'queued',
    createdOutboxIds,
    reusedOutboxIds,
    queuedOutboxIds,
    enqueueFailedOutboxIds: [],
  };
};

const buildThreadEventDefinition = (
  deps: TriggerRegistryDeps,
  input: {
    triggerId:
      | 'public_debate_entity_update.thread_started'
      | 'public_debate_entity_update.thread_failed'
      | 'public_debate_entity_update.reply_received'
      | 'public_debate_entity_update.reply_reviewed';
    eventType: 'thread_started' | 'thread_failed' | 'reply_received' | 'reply_reviewed';
  }
): CampaignNotificationTriggerDefinition => ({
  triggerId: input.triggerId,
  campaignKey: FUNKY_CAMPAIGN_KEY,
  templateId: 'public_debate_entity_update',
  description: `Manually enqueue the ${input.eventType} public debate entity update.`,
  inputSchema: ThreadTriggerSchema,
  inputFields: listSchemaFields(ThreadTriggerSchema),
  targetKind: 'thread',
  async execute(executionInput) {
    const payload = executionInput.payload as { threadId: string };
    const threadResult = await deps.correspondenceRepo.findThreadById(payload.threadId.trim());
    if (threadResult.isErr()) {
      return err(createDatabaseError('Failed to load public debate thread.'));
    }

    const thread = threadResult.value;
    if (thread === null) {
      return ok({
        status: 'skipped',
        reason: 'thread_not_found',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }

    if (
      thread.campaignKey !== FUNKY_CAMPAIGN_KEY ||
      thread.record.submissionPath !== 'platform_send'
    ) {
      return ok({
        status: 'skipped',
        reason: 'unsupported_thread_scope',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }

    const snapshot = deriveCurrentPlatformSendSnapshot(thread);
    if (snapshot.status !== 'derived' || snapshot.notification?.eventType !== input.eventType) {
      return ok({
        status: 'skipped',
        reason: 'phase_mismatch',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }

    const entityNameResult = await loadEntityName(deps.entityRepo, thread.entityCui);
    if (entityNameResult.isErr()) {
      return err(entityNameResult.error);
    }

    const notification = snapshot.notification;
    const enqueueResult = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo: deps.extendedNotificationsRepo,
        deliveryRepo: deps.deliveryRepo,
        composeJobScheduler: deps.composeJobScheduler,
      },
      {
        runId: buildRunId(input.triggerId),
        triggerSource: 'campaign_admin',
        triggeredByUserId: executionInput.actorUserId,
        eventType: notification.eventType,
        entityCui: thread.entityCui,
        entityName: entityNameResult.value,
        threadId: thread.id,
        threadKey: thread.threadKey,
        phase: thread.phase,
        institutionEmail: thread.record.institutionEmail,
        subject: thread.record.subject,
        occurredAt: notification.occurredAt.toISOString(),
        reusedOutboxComposeStrategy: 'skip_terminal_compose',
        ...(notification.reply !== undefined ? { replyEntryId: notification.reply.id } : {}),
        ...(notification.reply?.textBody !== undefined && notification.reply.textBody !== null
          ? {
              replyTextPreview:
                notification.reply.textBody.length > 400
                  ? `${notification.reply.textBody.slice(0, 397)}...`
                  : notification.reply.textBody,
            }
          : {}),
        ...(notification.basedOnEntryId !== undefined
          ? { basedOnEntryId: notification.basedOnEntryId }
          : {}),
        ...(notification.resolutionCode !== undefined
          ? { resolutionCode: notification.resolutionCode }
          : {}),
        ...(notification.reviewNotes !== undefined
          ? { reviewNotes: notification.reviewNotes }
          : {}),
      }
    );
    if (enqueueResult.isErr()) {
      return err(createDatabaseError('Failed to enqueue public debate entity updates.'));
    }

    if (enqueueResult.value.notificationIds.length === 0) {
      return ok({
        status: 'skipped',
        reason: 'no_subscribers',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }

    const status =
      enqueueResult.value.enqueueFailedOutboxIds.length > 0 ||
      (enqueueResult.value.skippedTerminalOutboxIds.length > 0 &&
        enqueueResult.value.queuedOutboxIds.length > 0)
        ? 'partial'
        : enqueueResult.value.queuedOutboxIds.length > 0 ||
            enqueueResult.value.createdOutboxIds.length > 0
          ? 'queued'
          : 'skipped';

    return ok({
      status,
      ...(status === 'skipped' ? { reason: 'already_processed' } : {}),
      createdOutboxIds: enqueueResult.value.createdOutboxIds,
      reusedOutboxIds: enqueueResult.value.reusedOutboxIds,
      queuedOutboxIds: enqueueResult.value.queuedOutboxIds,
      enqueueFailedOutboxIds: enqueueResult.value.enqueueFailedOutboxIds,
    });
  },
});

export const makeCampaignNotificationTriggerRegistry = (
  deps: TriggerRegistryDeps
): CampaignNotificationTriggerRegistry => {
  const definitions: readonly CampaignNotificationTriggerDefinition[] = [
    {
      triggerId: 'public_debate_campaign_welcome',
      campaignKey: FUNKY_CAMPAIGN_KEY,
      templateId: 'public_debate_campaign_welcome',
      description: 'Manually enqueue the public debate campaign welcome email.',
      inputSchema: TermsAcceptedTriggerSchema,
      inputFields: listSchemaFields(TermsAcceptedTriggerSchema),
      targetKind: 'user_entity',
      async execute(executionInput: CampaignNotificationTriggerExecutionInput) {
        const payload = executionInput.payload as { userId: string; entityCui: string };
        const contextResult = await loadTermsAcceptedContext(deps, payload);
        if (contextResult.isErr()) {
          return err(contextResult.error);
        }

        if (contextResult.value.status !== 'ready') {
          return ok({
            status: 'skipped',
            reason: 'missing_terms_acceptance',
            createdOutboxIds: [],
            reusedOutboxIds: [],
            queuedOutboxIds: [],
            enqueueFailedOutboxIds: [],
          });
        }

        const runId = buildRunId('public_debate_campaign_welcome');
        const enqueueResult = await enqueuePublicDebateTermsAcceptedNotifications(
          {
            notificationsRepo: deps.extendedNotificationsRepo,
            deliveryRepo: deps.deliveryRepo,
            composeJobScheduler: deps.composeJobScheduler,
          },
          {
            runId,
            source: 'campaign_admin_notifications',
            sourceEventId: buildTermsAcceptedSourceEventId('public_debate_campaign_welcome', runId),
            triggerSource: 'campaign_admin',
            triggeredByUserId: executionInput.actorUserId,
            userId: contextResult.value.userId,
            campaignKey: FUNKY_CAMPAIGN_KEY,
            entityCui: contextResult.value.entityCui,
            entityName: contextResult.value.entityName,
            acceptedTermsAt: contextResult.value.acceptedTermsAt,
            ...(contextResult.value.selectedEntities !== undefined
              ? { selectedEntities: contextResult.value.selectedEntities }
              : {}),
            globalPreferenceId: contextResult.value.globalPreferenceId,
            globalPreferenceActive: contextResult.value.globalPreferenceActive,
            entitySubscriptionId: contextResult.value.entitySubscriptionId,
            entitySubscriptionActive: contextResult.value.entitySubscriptionActive,
          }
        );
        if (enqueueResult.isErr()) {
          return err(createDatabaseError('Failed to enqueue public debate campaign welcome.'));
        }

        return ok(
          toTermsAcceptedExecutionResult('public_debate_campaign_welcome', enqueueResult.value)
        );
      },
    },
    {
      triggerId: 'public_debate_entity_subscription',
      campaignKey: FUNKY_CAMPAIGN_KEY,
      templateId: 'public_debate_entity_subscription',
      description: 'Manually enqueue the public debate entity subscription email.',
      inputSchema: TermsAcceptedTriggerSchema,
      inputFields: listSchemaFields(TermsAcceptedTriggerSchema),
      targetKind: 'user_entity',
      async execute(executionInput: CampaignNotificationTriggerExecutionInput) {
        const payload = executionInput.payload as { userId: string; entityCui: string };
        const contextResult = await loadTermsAcceptedContext(deps, payload);
        if (contextResult.isErr()) {
          return err(contextResult.error);
        }

        if (contextResult.value.status !== 'ready') {
          return ok({
            status: 'skipped',
            reason: 'missing_terms_acceptance',
            createdOutboxIds: [],
            reusedOutboxIds: [],
            queuedOutboxIds: [],
            enqueueFailedOutboxIds: [],
          });
        }

        const runId = buildRunId('public_debate_entity_subscription');
        const enqueueResult = await enqueuePublicDebateTermsAcceptedNotifications(
          {
            notificationsRepo: deps.extendedNotificationsRepo,
            deliveryRepo: deps.deliveryRepo,
            composeJobScheduler: deps.composeJobScheduler,
          },
          {
            runId,
            source: 'campaign_admin_notifications',
            sourceEventId: buildTermsAcceptedSourceEventId(
              'public_debate_entity_subscription',
              runId
            ),
            triggerSource: 'campaign_admin',
            triggeredByUserId: executionInput.actorUserId,
            userId: contextResult.value.userId,
            campaignKey: FUNKY_CAMPAIGN_KEY,
            entityCui: contextResult.value.entityCui,
            entityName: contextResult.value.entityName,
            acceptedTermsAt: contextResult.value.acceptedTermsAt,
            ...(contextResult.value.selectedEntities !== undefined
              ? { selectedEntities: contextResult.value.selectedEntities }
              : {}),
            globalPreferenceId: contextResult.value.globalPreferenceId,
            globalPreferenceActive: contextResult.value.globalPreferenceActive,
            entitySubscriptionId: contextResult.value.entitySubscriptionId,
            entitySubscriptionActive: contextResult.value.entitySubscriptionActive,
          }
        );
        if (enqueueResult.isErr()) {
          return err(createDatabaseError('Failed to enqueue public debate entity subscription.'));
        }

        return ok(
          toTermsAcceptedExecutionResult('public_debate_entity_subscription', enqueueResult.value)
        );
      },
    },
    buildThreadEventDefinition(deps, {
      triggerId: 'public_debate_entity_update.thread_started',
      eventType: 'thread_started',
    }),
    buildThreadEventDefinition(deps, {
      triggerId: 'public_debate_entity_update.thread_failed',
      eventType: 'thread_failed',
    }),
    buildThreadEventDefinition(deps, {
      triggerId: 'public_debate_entity_update.reply_received',
      eventType: 'reply_received',
    }),
    buildThreadEventDefinition(deps, {
      triggerId: 'public_debate_entity_update.reply_reviewed',
      eventType: 'reply_reviewed',
    }),
    makeAdminReviewedInteractionTriggerDefinition({
      learningProgressRepo: deps.learningProgressRepo,
      extendedNotificationsRepo: deps.extendedNotificationsRepo,
      deliveryRepo: deps.deliveryRepo,
      composeJobScheduler: deps.composeJobScheduler,
      entityRepo: deps.entityRepo,
      platformBaseUrl: deps.platformBaseUrl,
    }),
  ];

  const definitionMap = new Map(
    definitions.map((definition) => [
      `${definition.campaignKey}:${definition.triggerId}`,
      definition,
    ])
  );

  return {
    list(_campaignKey) {
      return definitions.map((definition) => ({
        triggerId: definition.triggerId,
        campaignKey: definition.campaignKey,
        ...(definition.familyId !== undefined ? { familyId: definition.familyId } : {}),
        templateId: definition.templateId,
        description: definition.description,
        inputFields: definition.inputFields,
        targetKind: definition.targetKind,
        ...(definition.capabilities !== undefined ? { capabilities: definition.capabilities } : {}),
      }));
    },

    get(campaignKey, triggerId) {
      return definitionMap.get(`${campaignKey}:${triggerId}`) ?? null;
    },
  };
};
