/**
 * Resend Webhook Routes
 *
 * Handles incoming webhook events from Resend for delivery status updates.
 */

import type {
  DeliveryRepository,
  WebhookEventRepository,
  WebhookVerifier,
  ExtendedNotificationsRepository,
  SvixHeaders,
} from '../../core/ports.js';
import type { ResendWebhookEvent } from '../../core/types.js';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the webhook routes.
 */
export interface WebhookRoutesDeps {
  webhookVerifier: WebhookVerifier;
  webhookEventRepo: WebhookEventRepository;
  deliveryRepo: DeliveryRepository;
  notificationsRepo: ExtendedNotificationsRepository;
  logger: Logger;
}

/**
 * Fastify request with raw body for signature verification.
 */
interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts delivery ID from Resend tags.
 * Tags can be array format or object format.
 */
const extractDeliveryId = (
  tags: { name: string; value: string }[] | Record<string, string> | undefined
): string | undefined => {
  if (tags === undefined) return undefined;

  if (Array.isArray(tags)) {
    const tag = tags.find((t) => t.name === 'delivery_id');
    return tag?.value;
  }

  // If not undefined and not array, it must be Record<string, string>
  return tags['delivery_id'];
};

/**
 * Extracts notification ID from Resend tags.
 */
const extractNotificationId = (
  tags: { name: string; value: string }[] | Record<string, string> | undefined
): string | undefined => {
  if (tags === undefined) return undefined;

  if (Array.isArray(tags)) {
    const tag = tags.find((t) => t.name === 'notification_id');
    return tag?.value;
  }

  // If not undefined and not array, it must be Record<string, string>
  return tags['notification_id'];
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the webhook routes plugin.
 */
export const makeWebhookRoutes = (deps: WebhookRoutesDeps): FastifyPluginAsync => {
  const { webhookVerifier, webhookEventRepo, deliveryRepo, notificationsRepo, logger } = deps;
  const log = logger.child({ routes: 'webhook' });

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync pattern requires async
  return async (fastify) => {
    // POST /api/v1/webhooks/resend
    fastify.post('/resend', async (request: RequestWithRawBody, reply: FastifyReply) => {
      // 1. Extract svix headers
      const svixId = request.headers['svix-id'] as string | undefined;
      const svixTimestamp = request.headers['svix-timestamp'] as string | undefined;
      const svixSignature = request.headers['svix-signature'] as string | undefined;

      if (svixId === undefined || svixTimestamp === undefined || svixSignature === undefined) {
        log.warn('Missing svix headers');
        return reply.status(400).send({ error: 'Missing svix headers' });
      }

      // 2. Get raw body for verification
      const rawBody = request.rawBody;

      if (rawBody === undefined) {
        log.error('Raw body not available - ensure rawBody parser is configured');
        return reply.status(500).send({ error: 'Internal server error' });
      }

      // 3. Verify webhook signature
      const headers: SvixHeaders = {
        svixId,
        svixTimestamp,
        svixSignature,
      };

      const verifyResult = await webhookVerifier.verify(rawBody, headers);

      if (verifyResult.isErr()) {
        log.warn({ error: verifyResult.error }, 'Webhook signature verification failed');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      const event: ResendWebhookEvent = verifyResult.value;

      log.debug(
        { svixId, eventType: event.type, emailId: event.data.email_id },
        'Received webhook event'
      );

      // 4. Extract delivery ID from tags
      const deliveryId = extractDeliveryId(event.data.tags);

      // 5. Insert event for idempotency (using svix-id as unique key)
      const insertInput = {
        svixId,
        eventType: event.type,
        resendEmailId: event.data.email_id,
        payload: event as unknown as Record<string, unknown>,
        ...(deliveryId !== undefined ? { deliveryId } : {}),
      };
      const insertResult = await webhookEventRepo.insert(insertInput);

      if (insertResult.isErr()) {
        if (insertResult.error.type === 'DuplicateWebhookEvent') {
          log.debug({ svixId }, 'Duplicate webhook event (already processed)');
          return reply.status(200).send({ status: 'already_processed' });
        }

        log.error({ error: insertResult.error }, 'Failed to insert webhook event');
        return reply.status(500).send({ error: 'Internal server error' });
      }

      // 6. Update delivery status based on event type
      if (deliveryId !== undefined) {
        await processDeliveryEvent(event, deliveryId, extractNotificationId(event.data.tags), {
          deliveryRepo,
          notificationsRepo,
          log,
        });
      } else {
        log.warn(
          { svixId, eventType: event.type, emailId: event.data.email_id },
          'Webhook event has no delivery_id tag'
        );
      }

      // 7. Mark event as processed
      const markResult = await webhookEventRepo.markProcessed(svixId);

      if (markResult.isErr()) {
        log.error({ error: markResult.error, svixId }, 'Failed to mark webhook event as processed');
        // Don't fail the request - the event was handled
      }

      log.info({ svixId, eventType: event.type, deliveryId }, 'Webhook event processed');

      return reply.status(200).send({ status: 'processed' });
    });
  };
};

/**
 * Processes a webhook event and updates delivery/notification status.
 */
async function processDeliveryEvent(
  event: ResendWebhookEvent,
  deliveryId: string,
  notificationId: string | undefined,
  deps: {
    deliveryRepo: DeliveryRepository;
    notificationsRepo: ExtendedNotificationsRepository;
    log: Logger;
  }
): Promise<void> {
  const { deliveryRepo, notificationsRepo, log } = deps;

  switch (event.type) {
    case 'email.sent': {
      // Reconcile if our DB update failed after Resend accepted
      const result = await deliveryRepo.updateStatusIfStillSending(deliveryId, 'sent', {
        resendEmailId: event.data.email_id,
      });

      if (result.isOk() && result.value) {
        log.info({ deliveryId }, 'Delivery status reconciled to sent via webhook');
      }
      break;
    }

    case 'email.delivered': {
      const result = await deliveryRepo.updateStatus(deliveryId, { status: 'delivered' });

      if (result.isErr()) {
        log.error({ error: result.error, deliveryId }, 'Failed to update delivery to delivered');
      } else {
        log.info({ deliveryId }, 'Delivery marked as delivered');
      }
      break;
    }

    case 'email.bounced': {
      const isPermanentBounce = event.data.bounce?.type === 'Permanent';
      const status = isPermanentBounce ? 'suppressed' : 'failed_transient';
      const lastError = `bounced: ${event.data.bounce?.subType ?? 'unknown'}`;

      const result = await deliveryRepo.updateStatus(deliveryId, { status, lastError });

      if (result.isErr()) {
        log.error({ error: result.error, deliveryId }, 'Failed to update delivery for bounce');
      } else {
        log.info({ deliveryId, status, isPermanentBounce }, 'Delivery updated for bounce');
      }

      // Deactivate notification for permanent bounces
      if (isPermanentBounce && notificationId !== undefined) {
        const deactivateResult = await notificationsRepo.deactivate(notificationId);

        if (deactivateResult.isErr()) {
          log.error(
            { error: deactivateResult.error, notificationId },
            'Failed to deactivate notification'
          );
        } else {
          log.info({ notificationId }, 'Notification deactivated due to permanent bounce');
        }
      }
      break;
    }

    case 'email.complained':
    case 'email.suppressed': {
      const lastError = `${event.type}: ${event.data.reason ?? 'unknown'}`;

      const result = await deliveryRepo.updateStatus(deliveryId, {
        status: 'suppressed',
        lastError,
      });

      if (result.isErr()) {
        log.error({ error: result.error, deliveryId }, 'Failed to update delivery for suppression');
      } else {
        log.info({ deliveryId, eventType: event.type }, 'Delivery marked as suppressed');
      }

      // Deactivate notification to stop future sends
      if (notificationId !== undefined) {
        const deactivateResult = await notificationsRepo.deactivate(notificationId);

        if (deactivateResult.isErr()) {
          log.error(
            { error: deactivateResult.error, notificationId },
            'Failed to deactivate notification'
          );
        } else {
          log.info({ notificationId }, 'Notification deactivated due to complaint/suppression');
        }
      }
      break;
    }

    case 'email.failed': {
      const lastError = event.data.error ?? 'Unknown failure';

      const result = await deliveryRepo.updateStatus(deliveryId, {
        status: 'failed_permanent',
        lastError,
      });

      if (result.isErr()) {
        log.error({ error: result.error, deliveryId }, 'Failed to update delivery for failure');
      } else {
        log.info({ deliveryId }, 'Delivery marked as failed_permanent');
      }
      break;
    }

    case 'email.delivery_delayed': {
      // Just log for observability, keep status as 'sent'
      log.warn({ deliveryId, eventType: event.type }, 'Email delivery delayed');
      break;
    }

    default:
      log.debug({ deliveryId, eventType: event.type }, 'Unhandled webhook event type');
  }
}
