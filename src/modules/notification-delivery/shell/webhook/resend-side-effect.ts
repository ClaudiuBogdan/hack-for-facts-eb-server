import {
  FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE,
  parseWeeklyProgressDigestOutboxMetadata,
} from '../../core/weekly-progress-digest.js';

import type {
  DeliveryRepository,
  WeeklyProgressDigestPostSendReconciler,
} from '../../core/ports.js';
import type { NotificationsRepository } from '@/modules/notifications/index.js';
import type {
  ResendEmailWebhookEvent,
  ResendWebhookSideEffect,
  ResendWebhookSideEffectInput,
} from '@/modules/resend-webhooks/index.js';
import type { Logger } from 'pino';

const extractTagValue = (
  tags: ResendEmailWebhookEvent['data']['tags'],
  tagName: string
): string | undefined => {
  if (tags === undefined) {
    return undefined;
  }

  if (Array.isArray(tags)) {
    const tag = tags.find((entry) => entry.name === tagName);
    return tag?.value;
  }

  return tags[tagName];
};

export interface ResendWebhookDeliverySideEffectDeps {
  deliveryRepo: DeliveryRepository;
  notificationsRepo: NotificationsRepository;
  logger: Logger;
  weeklyProgressDigestPostSendReconciler?: WeeklyProgressDigestPostSendReconciler;
}

const deactivateNotification = async (
  notificationsRepo: NotificationsRepository,
  notificationId: string,
  log: Logger
): Promise<void> => {
  const notificationResult = await notificationsRepo.findById(notificationId);
  if (notificationResult.isErr()) {
    log.error({ error: notificationResult.error, notificationId }, 'Failed to load notification');
    return;
  }

  if (notificationResult.value === null) {
    log.warn({ notificationId }, 'Notification missing during resend webhook deactivation');
    return;
  }

  if (!notificationResult.value.isActive) {
    return;
  }

  const updateResult = await notificationsRepo.update(notificationId, { isActive: false });
  if (updateResult.isErr()) {
    log.error({ error: updateResult.error, notificationId }, 'Failed to deactivate notification');
  }
};

const getSourceNotificationIds = async (
  deliveryRepo: DeliveryRepository,
  deliveryId: string,
  fallbackNotificationId: string | undefined,
  log: Logger
): Promise<string[]> => {
  if (fallbackNotificationId !== undefined) {
    return [fallbackNotificationId];
  }

  const outboxResult = await deliveryRepo.findById(deliveryId);
  if (outboxResult.isErr()) {
    log.error(
      { error: outboxResult.error, deliveryId },
      'Failed to load outbox row for bundle webhook handling'
    );
    return [];
  }

  if (outboxResult.value === null) {
    log.debug({ deliveryId }, 'Outbox row missing during bundle webhook handling');
    return [];
  }

  const sourceNotificationIds = outboxResult.value.metadata['sourceNotificationIds'];
  if (!Array.isArray(sourceNotificationIds)) {
    return [];
  }

  return sourceNotificationIds.filter((value): value is string => typeof value === 'string');
};

const reconcileWeeklyProgressDigestDelivery = async (input: {
  deliveryId: string;
  deliveryRepo: DeliveryRepository;
  weeklyProgressDigestPostSendReconciler: WeeklyProgressDigestPostSendReconciler | undefined;
  resendInput: ResendWebhookSideEffectInput;
  log: Logger;
}): Promise<void> => {
  if (input.weeklyProgressDigestPostSendReconciler === undefined) {
    return;
  }

  const outboxResult = await input.deliveryRepo.findById(input.deliveryId);
  if (outboxResult.isErr()) {
    input.log.error(
      { error: outboxResult.error, deliveryId: input.deliveryId },
      'Failed to load delivery for weekly progress digest webhook reconciliation'
    );
    return;
  }

  const outbox = outboxResult.value;
  if (outbox === null) {
    input.log.debug(
      { deliveryId: input.deliveryId },
      'Skipping weekly progress digest webhook reconciliation because delivery is missing'
    );
    return;
  }

  if (outbox.notificationType !== FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE) {
    return;
  }

  const metadataResult = parseWeeklyProgressDigestOutboxMetadata(outbox.metadata);
  if (metadataResult.isErr()) {
    input.log.error(
      { deliveryId: input.deliveryId, error: metadataResult.error },
      'Invalid weekly progress digest metadata during webhook reconciliation'
    );
    return;
  }

  const reconcileResult = await input.weeklyProgressDigestPostSendReconciler.reconcile({
    outboxId: outbox.id,
    userId: outbox.userId,
    sentAt: outbox.sentAt ?? input.resendInput.storedEvent.emailCreatedAt,
    metadata: metadataResult.value,
  });
  if (reconcileResult.isErr()) {
    input.log.error(
      { deliveryId: input.deliveryId, error: reconcileResult.error },
      'Failed to reconcile weekly progress digest cursor from resend webhook'
    );
  }
};

export const makeResendWebhookDeliverySideEffect = (
  deps: ResendWebhookDeliverySideEffectDeps
): ResendWebhookSideEffect => {
  const { deliveryRepo, notificationsRepo, logger, weeklyProgressDigestPostSendReconciler } = deps;
  const log = logger.child({ component: 'ResendWebhookDeliverySideEffect' });

  return {
    async handle(input: ResendWebhookSideEffectInput): Promise<void> {
      const deliveryId = extractTagValue(input.event.data.tags, 'delivery_id');
      const notificationId = extractTagValue(input.event.data.tags, 'notification_id');

      if (deliveryId === undefined) {
        log.debug(
          {
            svixId: input.storedEvent.svixId,
            eventType: input.event.type,
            emailId: input.event.data.email_id,
          },
          'Skipping notification-delivery webhook side effect because delivery_id tag is missing'
        );
        return;
      }

      switch (input.event.type) {
        case 'email.sent': {
          const sentAt = input.storedEvent.emailCreatedAt;
          const result = await deliveryRepo.updateStatusIfStillSending(deliveryId, 'sent', {
            resendEmailId: input.event.data.email_id,
            sentAt,
          });

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to reconcile sent delivery');
          }

          await reconcileWeeklyProgressDigestDelivery({
            deliveryId,
            deliveryRepo,
            weeklyProgressDigestPostSendReconciler,
            resendInput: input,
            log,
          });
          return;
        }

        case 'email.delivered': {
          const result = await deliveryRepo.updateStatusIfCurrentIn(
            deliveryId,
            ['sending', 'sent', 'webhook_timeout'],
            'delivered',
            {
              resendEmailId: input.event.data.email_id,
              sentAt: input.storedEvent.emailCreatedAt,
            }
          );
          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to mark delivery delivered');
          }

          await reconcileWeeklyProgressDigestDelivery({
            deliveryId,
            deliveryRepo,
            weeklyProgressDigestPostSendReconciler,
            resendInput: input,
            log,
          });
          return;
        }

        case 'email.bounced': {
          const isPermanentBounce = input.event.data.bounce?.type === 'Permanent';
          const status = isPermanentBounce ? 'suppressed' : 'failed_transient';
          const result = await deliveryRepo.updateStatusIfCurrentIn(
            deliveryId,
            isPermanentBounce
              ? ['sending', 'sent', 'delivered', 'webhook_timeout']
              : ['sending', 'sent'],
            status,
            {
              lastError: `bounced: ${input.event.data.bounce?.subType ?? 'unknown'}`,
            }
          );

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to update bounced delivery');
          }

          if (isPermanentBounce) {
            const notificationIds = await getSourceNotificationIds(
              deliveryRepo,
              deliveryId,
              notificationId,
              log
            );

            for (const id of notificationIds) {
              await deactivateNotification(notificationsRepo, id, log);
            }
          }
          return;
        }

        case 'email.complained':
        case 'email.suppressed': {
          const result = await deliveryRepo.updateStatusIfCurrentIn(
            deliveryId,
            ['sending', 'sent', 'delivered', 'webhook_timeout'],
            'suppressed',
            {
              lastError: `${input.event.type}: ${input.event.data.reason ?? 'unknown'}`,
            }
          );

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to suppress delivery');
          }

          const notificationIds = await getSourceNotificationIds(
            deliveryRepo,
            deliveryId,
            notificationId,
            log
          );

          for (const id of notificationIds) {
            await deactivateNotification(notificationsRepo, id, log);
          }
          return;
        }

        case 'email.failed': {
          const result = await deliveryRepo.updateStatusIfCurrentIn(
            deliveryId,
            ['sending', 'sent'],
            'failed_permanent',
            {
              lastError: input.event.data.error ?? input.event.data.reason ?? 'email.failed',
            }
          );

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to mark delivery failed');
          }
          return;
        }

        case 'email.delivery_delayed': {
          let currentStatus: string | undefined;
          const deliveryResult = await deliveryRepo.findById(deliveryId);
          if (deliveryResult.isOk() && deliveryResult.value !== null) {
            currentStatus = deliveryResult.value.status;
          }

          log.warn(
            {
              deliveryId,
              emailId: input.event.data.email_id,
              eventType: input.event.type,
              currentStatus,
            },
            'Delivery delayed webhook received'
          );
          return;
        }

        default:
          return;
      }
    },
  };
};
