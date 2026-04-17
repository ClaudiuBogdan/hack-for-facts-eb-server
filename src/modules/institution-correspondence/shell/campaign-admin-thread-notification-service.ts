import { randomUUID } from 'node:crypto';

import { err, ok, type Result } from 'neverthrow';

import { type ReusedOutboxComposeStrategy } from '@/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.js';
import {
  buildPublicDebateEntityAudienceSummaryKey,
  enqueuePublicDebateAdminResponseNotifications,
  type ComposeJobScheduler,
  type DeliveryRepository,
  type EnqueuePublicDebateAdminResponseNotificationsResult,
  type ExtendedNotificationsRepository,
  type PublicDebateEntityAudienceSummary,
  type PublicDebateEntityAudienceSummaryReader,
} from '@/modules/notification-delivery/index.js';

import { getLatestAdminResponseEvent, readAdminResponseEvents } from '../core/admin-workflow.js';
import { createDatabaseError, type InstitutionCorrespondenceError } from '../core/errors.js';

import type { AdminResponseEvent, ThreadRecord } from '../core/types.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { Logger } from 'pino';

export type CampaignAdminThreadNotificationExecutionStatus = 'queued' | 'skipped' | 'partial';
export type CampaignAdminThreadNotificationExecutionReason =
  | 'no_subscribers'
  | 'no_eligible_recipients'
  | 'already_processed'
  | 'enqueue_failed'
  | 'admin_response_not_found';

export interface CampaignAdminThreadNotificationExecution extends PublicDebateEntityAudienceSummary {
  requested: true;
  status: CampaignAdminThreadNotificationExecutionStatus;
  reason?: CampaignAdminThreadNotificationExecutionReason;
  createdOutboxIds: string[];
  reusedOutboxIds: string[];
  queuedOutboxIds: string[];
  enqueueFailedOutboxIds: string[];
}

export interface CampaignAdminThreadNotificationService {
  summarizeAudiences(
    threads: readonly ThreadRecord[]
  ): Promise<
    Result<Map<string, PublicDebateEntityAudienceSummary>, InstitutionCorrespondenceError>
  >;
  notifyResponseById(input: {
    thread: ThreadRecord;
    responseEventId: string;
    actorUserId: string;
    triggerSource: 'campaign_admin_api' | 'campaign_admin';
    reusedOutboxComposeStrategy?: ReusedOutboxComposeStrategy;
  }): Promise<CampaignAdminThreadNotificationExecution>;
  notifyLatestResponse(input: {
    thread: ThreadRecord;
    actorUserId: string;
    triggerSource: 'campaign_admin';
    reusedOutboxComposeStrategy?: ReusedOutboxComposeStrategy;
  }): Promise<CampaignAdminThreadNotificationExecution>;
}

export interface MakeCampaignAdminThreadNotificationServiceDeps {
  entityRepo: EntityRepository;
  audienceSummaryReader: PublicDebateEntityAudienceSummaryReader;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
  logger: Logger;
}

const emptyAudienceSummary = (): PublicDebateEntityAudienceSummary => ({
  requesterCount: 0,
  subscriberCount: 0,
  eligibleRequesterCount: 0,
  eligibleSubscriberCount: 0,
});

const mergeExecution = (
  summary: PublicDebateEntityAudienceSummary,
  input: Omit<
    CampaignAdminThreadNotificationExecution,
    keyof PublicDebateEntityAudienceSummary | 'requested'
  >
): CampaignAdminThreadNotificationExecution => ({
  requested: true,
  ...summary,
  ...input,
});

const buildThreadAudienceSummaryKey = (thread: ThreadRecord): string =>
  buildPublicDebateEntityAudienceSummaryKey({
    entityCui: thread.entityCui,
    requesterUserId: thread.record.ownerUserId ?? null,
  });

const mapEnqueueResultToExecution = (
  summary: PublicDebateEntityAudienceSummary,
  result: EnqueuePublicDebateAdminResponseNotificationsResult
): CampaignAdminThreadNotificationExecution => {
  const hasQueued = result.queuedOutboxIds.length > 0 || result.createdOutboxIds.length > 0;
  const hasFailures = result.enqueueFailedOutboxIds.length > 0;
  const hasAlreadyProcessed =
    result.reusedOutboxIds.length > 0 && result.queuedOutboxIds.length === 0;
  const hasPartialAlreadyProcessed =
    result.skippedTerminalOutboxIds.length > 0 && result.queuedOutboxIds.length > 0;

  if (hasFailures) {
    return mergeExecution(summary, {
      status: 'partial',
      reason: 'enqueue_failed',
      createdOutboxIds: result.createdOutboxIds,
      reusedOutboxIds: result.reusedOutboxIds,
      queuedOutboxIds: result.queuedOutboxIds,
      enqueueFailedOutboxIds: result.enqueueFailedOutboxIds,
    });
  }

  if (hasPartialAlreadyProcessed) {
    return mergeExecution(summary, {
      status: 'partial',
      reason: 'already_processed',
      createdOutboxIds: result.createdOutboxIds,
      reusedOutboxIds: result.reusedOutboxIds,
      queuedOutboxIds: result.queuedOutboxIds,
      enqueueFailedOutboxIds: result.enqueueFailedOutboxIds,
    });
  }

  if (hasQueued) {
    return mergeExecution(summary, {
      status: 'queued',
      createdOutboxIds: result.createdOutboxIds,
      reusedOutboxIds: result.reusedOutboxIds,
      queuedOutboxIds: result.queuedOutboxIds,
      enqueueFailedOutboxIds: result.enqueueFailedOutboxIds,
    });
  }

  if (hasAlreadyProcessed) {
    return mergeExecution(summary, {
      status: 'skipped',
      reason: 'already_processed',
      createdOutboxIds: result.createdOutboxIds,
      reusedOutboxIds: result.reusedOutboxIds,
      queuedOutboxIds: result.queuedOutboxIds,
      enqueueFailedOutboxIds: result.enqueueFailedOutboxIds,
    });
  }

  return mergeExecution(summary, {
    status: 'partial',
    reason: 'enqueue_failed',
    createdOutboxIds: result.createdOutboxIds,
    reusedOutboxIds: result.reusedOutboxIds,
    queuedOutboxIds: result.queuedOutboxIds,
    enqueueFailedOutboxIds: result.enqueueFailedOutboxIds,
  });
};

const loadEntityName = async (
  entityRepo: EntityRepository,
  logger: Logger,
  entityCui: string
): Promise<string> => {
  const entityResult = await entityRepo.getById(entityCui);
  if (entityResult.isErr()) {
    logger.warn(
      { err: entityResult.error, entityCui },
      'Failed to load entity name for campaign-admin thread notification'
    );
    return entityCui;
  }

  const entityName = entityResult.value?.name.trim();
  return entityName !== undefined && entityName !== '' ? entityName : entityCui;
};

const resolveSummaryResult = async (
  deps: Pick<MakeCampaignAdminThreadNotificationServiceDeps, 'audienceSummaryReader' | 'logger'>,
  thread: ThreadRecord
): Promise<
  Result<
    {
      summary: PublicDebateEntityAudienceSummary;
      rawRecipientCount: number;
      eligibleRecipientCount: number;
    },
    InstitutionCorrespondenceError
  >
> => {
  const summaryResult = await deps.audienceSummaryReader.summarize([
    {
      entityCui: thread.entityCui,
      requesterUserId: thread.record.ownerUserId ?? null,
    },
  ]);

  if (summaryResult.isErr()) {
    deps.logger.error(
      { err: summaryResult.error, threadId: thread.id, entityCui: thread.entityCui },
      'Failed to load campaign-admin thread notification audience summary'
    );
    return err(
      createDatabaseError(
        'Failed to load campaign-admin thread notification audience summary',
        summaryResult.error
      )
    );
  }

  const summary =
    summaryResult.value.get(buildThreadAudienceSummaryKey(thread)) ?? emptyAudienceSummary();

  return ok({
    summary,
    rawRecipientCount: summary.requesterCount + summary.subscriberCount,
    eligibleRecipientCount: summary.eligibleRequesterCount + summary.eligibleSubscriberCount,
  });
};

const buildNoRecipientExecution = (
  summary: PublicDebateEntityAudienceSummary
): CampaignAdminThreadNotificationExecution => {
  const rawRecipientCount = summary.requesterCount + summary.subscriberCount;

  return mergeExecution(summary, {
    status: 'skipped',
    reason: rawRecipientCount === 0 ? 'no_subscribers' : 'no_eligible_recipients',
    createdOutboxIds: [],
    reusedOutboxIds: [],
    queuedOutboxIds: [],
    enqueueFailedOutboxIds: [],
  });
};

export const makeCampaignAdminThreadNotificationService = (
  deps: MakeCampaignAdminThreadNotificationServiceDeps
): CampaignAdminThreadNotificationService => {
  const logger = deps.logger.child({ component: 'CampaignAdminThreadNotificationService' });

  const summarizeAudiences: CampaignAdminThreadNotificationService['summarizeAudiences'] = async (
    threads
  ) => {
    const summaryResult = await deps.audienceSummaryReader.summarize(
      threads.map((thread) => ({
        entityCui: thread.entityCui,
        requesterUserId: thread.record.ownerUserId ?? null,
      }))
    );

    if (summaryResult.isErr()) {
      return err(
        createDatabaseError(
          'Failed to load campaign-admin institution-thread notification audiences',
          summaryResult.error
        )
      );
    }

    return ok(
      new Map(
        threads.map((thread) => [
          thread.id,
          summaryResult.value.get(buildThreadAudienceSummaryKey(thread)) ?? emptyAudienceSummary(),
        ])
      )
    );
  };

  const notifyResponse = async (input: {
    thread: ThreadRecord;
    responseEvent: AdminResponseEvent | null;
    actorUserId: string;
    triggerSource: 'campaign_admin_api' | 'campaign_admin';
    reusedOutboxComposeStrategy?: ReusedOutboxComposeStrategy | undefined;
  }): Promise<CampaignAdminThreadNotificationExecution> => {
    const summaryLookup = await resolveSummaryResult(
      {
        audienceSummaryReader: deps.audienceSummaryReader,
        logger,
      },
      input.thread
    );

    if (summaryLookup.isErr()) {
      return mergeExecution(emptyAudienceSummary(), {
        status: 'partial',
        reason: 'enqueue_failed',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }

    const { summary, eligibleRecipientCount } = summaryLookup.value;

    if (input.responseEvent === null) {
      return mergeExecution(summary, {
        status: 'skipped',
        reason: 'admin_response_not_found',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }

    if (eligibleRecipientCount === 0) {
      return buildNoRecipientExecution(summary);
    }

    const entityName = await loadEntityName(deps.entityRepo, logger, input.thread.entityCui);
    const enqueueResult = await enqueuePublicDebateAdminResponseNotifications(
      {
        notificationsRepo: deps.extendedNotificationsRepo,
        deliveryRepo: deps.deliveryRepo,
        composeJobScheduler: deps.composeJobScheduler,
      },
      {
        runId: `campaign-admin-thread-response-${randomUUID()}`,
        entityCui: input.thread.entityCui,
        entityName,
        threadId: input.thread.id,
        threadKey: input.thread.threadKey,
        responseEventId: input.responseEvent.id,
        responseStatus: input.responseEvent.responseStatus,
        responseDate: input.responseEvent.responseDate,
        messageContent: input.responseEvent.messageContent,
        ownerUserId: input.thread.record.ownerUserId ?? null,
        triggerSource: input.triggerSource,
        triggeredByUserId: input.actorUserId,
        ...(input.reusedOutboxComposeStrategy !== undefined
          ? { reusedOutboxComposeStrategy: input.reusedOutboxComposeStrategy }
          : {}),
      }
    );

    if (enqueueResult.isErr()) {
      logger.error(
        {
          err: enqueueResult.error,
          threadId: input.thread.id,
          responseEventId: input.responseEvent.id,
        },
        'Failed to enqueue campaign-admin thread response notifications'
      );
      return mergeExecution(summary, {
        status: 'partial',
        reason: 'enqueue_failed',
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      });
    }

    if (enqueueResult.value.notificationIds.length === 0) {
      return buildNoRecipientExecution(summary);
    }

    return mapEnqueueResultToExecution(summary, enqueueResult.value);
  };

  return {
    summarizeAudiences,
    async notifyResponseById(input) {
      const responseEvent =
        readAdminResponseEvents(input.thread.record).find(
          (candidate) => candidate.id === input.responseEventId
        ) ?? null;

      return notifyResponse({
        thread: input.thread,
        responseEvent,
        actorUserId: input.actorUserId,
        triggerSource: input.triggerSource,
        reusedOutboxComposeStrategy: input.reusedOutboxComposeStrategy,
      });
    },
    async notifyLatestResponse(input) {
      return notifyResponse({
        thread: input.thread,
        responseEvent: getLatestAdminResponseEvent(input.thread.record),
        actorUserId: input.actorUserId,
        triggerSource: input.triggerSource,
        reusedOutboxComposeStrategy: input.reusedOutboxComposeStrategy,
      });
    },
  };
};
