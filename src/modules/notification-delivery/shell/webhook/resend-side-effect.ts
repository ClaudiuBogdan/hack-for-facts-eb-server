import type { DeliveryRepository } from '../../core/ports.js';
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

export const makeResendWebhookDeliverySideEffect = (
  deps: ResendWebhookDeliverySideEffectDeps
): ResendWebhookSideEffect => {
  const { deliveryRepo, notificationsRepo, logger } = deps;
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
          const result = await deliveryRepo.updateStatusIfStillSending(deliveryId, 'sent', {
            resendEmailId: input.event.data.email_id,
          });

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to reconcile sent delivery');
          }
          return;
        }

        case 'email.delivered': {
          const result = await deliveryRepo.updateStatus(deliveryId, { status: 'delivered' });
          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to mark delivery delivered');
          }
          return;
        }

        case 'email.bounced': {
          const isPermanentBounce = input.event.data.bounce?.type === 'Permanent';
          const status = isPermanentBounce ? 'suppressed' : 'failed_transient';
          const result = await deliveryRepo.updateStatus(deliveryId, {
            status,
            lastError: `bounced: ${input.event.data.bounce?.subType ?? 'unknown'}`,
          });

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to update bounced delivery');
          }

          if (isPermanentBounce) {
            if (notificationId === undefined) {
              log.debug({ deliveryId }, 'Permanent bounce missing notification_id tag');
              return;
            }

            await deactivateNotification(notificationsRepo, notificationId, log);
          }
          return;
        }

        case 'email.complained':
        case 'email.suppressed': {
          const result = await deliveryRepo.updateStatus(deliveryId, {
            status: 'suppressed',
            lastError: `${input.event.type}: ${input.event.data.reason ?? 'unknown'}`,
          });

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to suppress delivery');
          }

          if (notificationId === undefined) {
            log.debug({ deliveryId }, 'Suppression event missing notification_id tag');
            return;
          }

          await deactivateNotification(notificationsRepo, notificationId, log);
          return;
        }

        case 'email.failed': {
          const result = await deliveryRepo.updateStatus(deliveryId, {
            status: 'failed_permanent',
            lastError: input.event.data.error ?? input.event.data.reason ?? 'email.failed',
          });

          if (result.isErr()) {
            log.error({ error: result.error, deliveryId }, 'Failed to mark delivery failed');
          }
          return;
        }

        default:
          return;
      }
    },
  };
};
