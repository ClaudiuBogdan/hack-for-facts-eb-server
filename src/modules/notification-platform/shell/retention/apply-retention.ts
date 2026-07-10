import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { createDatabaseError, createValidationError } from '../../core/shared/errors.js';

import type { PlatformDeliveryError } from '../../core/delivery/errors.js';
import type { UserDbClient } from '@/infra/database/client.js';

const DETAILED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface RetentionSummary {
  deliveryAttemptsDeleted: number;
  providerWebhooksDeleted: number;
  digestMembersDeleted: number;
  deliveriesDeleted: number;
  digestBatchesDeleted: number;
  logicalNotificationsDeleted: number;
  eventsRedacted: number;
  eventsDeleted: number;
}

export interface RetentionRunner {
  applyRetention(input: {
    batchLimit: number;
    now: Date;
  }): Promise<Result<RetentionSummary, PlatformDeliveryError>>;
}

const affectedRows = (value: bigint | undefined): number => Number(value ?? 0n);

export const makeRetentionRunner = (db: UserDbClient): RetentionRunner => ({
  async applyRetention(input) {
    if (!Number.isInteger(input.batchLimit) || input.batchLimit < 1) {
      return err(createValidationError('batchLimit must be a positive integer', 'batchLimit'));
    }

    const detailedCutoff = new Date(input.now.getTime() - DETAILED_RETENTION_MS);

    try {
      const deliveryAttempts = await sql`
        DELETE FROM notification_delivery_attempts
        WHERE id IN (
          SELECT id
          FROM notification_delivery_attempts
          WHERE created_at < ${detailedCutoff}
          ORDER BY created_at, id
          LIMIT ${input.batchLimit}
        )
      `.execute(db);

      const providerWebhooks = await sql`
        DELETE FROM resend_wh_emails
        WHERE id IN (
          SELECT id
          FROM resend_wh_emails
          WHERE webhook_received_at < ${detailedCutoff}
          ORDER BY webhook_received_at, id
          LIMIT ${input.batchLimit}
        )
      `.execute(db);

      const digestMembers = await sql`
        DELETE FROM notification_digest_members AS members
        USING (
          SELECT candidate.batch_id, candidate.logical_notification_id
          FROM notification_digest_members AS candidate
          INNER JOIN logical_notifications AS logical
            ON logical.id = candidate.logical_notification_id
          WHERE logical.retention_expires_at <= ${input.now}
          ORDER BY logical.retention_expires_at, candidate.batch_id, candidate.logical_notification_id
          LIMIT ${input.batchLimit}
        ) AS expired
        WHERE members.batch_id = expired.batch_id
          AND members.logical_notification_id = expired.logical_notification_id
      `.execute(db);

      const deliveries = await sql`
        DELETE FROM notification_deliveries AS delivery
        WHERE id IN (
          SELECT candidate.id
          FROM notification_deliveries AS candidate
          WHERE candidate.retention_expires_at <= ${input.now}
            AND NOT EXISTS (
              SELECT 1
              FROM notification_delivery_attempts AS attempt
              WHERE attempt.delivery_id = candidate.id
            )
          ORDER BY candidate.retention_expires_at, candidate.id
          LIMIT ${input.batchLimit}
        )
      `.execute(db);

      const digestBatches = await sql`
        DELETE FROM notification_digest_batches AS batch
        WHERE id IN (
          SELECT candidate.id
          FROM notification_digest_batches AS candidate
          WHERE candidate.window_end_utc + interval '2 years' <= ${input.now}
            AND NOT EXISTS (
              SELECT 1
              FROM notification_digest_members AS member
              WHERE member.batch_id = candidate.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM notification_deliveries AS delivery
              WHERE delivery.digest_batch_id = candidate.id
            )
          ORDER BY candidate.window_end_utc, candidate.id
          LIMIT ${input.batchLimit}
        )
      `.execute(db);

      const logicalNotifications = await sql`
        DELETE FROM logical_notifications AS logical
        WHERE id IN (
          SELECT candidate.id
          FROM logical_notifications AS candidate
          WHERE candidate.retention_expires_at <= ${input.now}
            AND NOT EXISTS (
              SELECT 1
              FROM notification_deliveries AS delivery
              WHERE delivery.logical_notification_id = candidate.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM notification_digest_members AS member
              WHERE member.logical_notification_id = candidate.id
            )
          ORDER BY candidate.retention_expires_at, candidate.id
          LIMIT ${input.batchLimit}
        )
      `.execute(db);

      const redactedEvents = await sql`
        UPDATE notification_events
        SET facts = '{}'::jsonb,
            correlation_id = NULL,
            causation_id = NULL,
            resolution_cursor = NULL,
            claim_token = NULL,
            claim_expires_at = NULL,
            updated_at = ${input.now}
        WHERE id IN (
          SELECT candidate.id
          FROM notification_events AS candidate
          WHERE candidate.retention_expires_at <= ${input.now}
            AND EXISTS (
              SELECT 1
              FROM logical_notifications AS logical
              WHERE logical.event_id = candidate.id
            )
            AND (
              candidate.facts IS DISTINCT FROM '{}'::jsonb
              OR candidate.correlation_id IS NOT NULL
              OR candidate.causation_id IS NOT NULL
              OR candidate.resolution_cursor IS NOT NULL
              OR candidate.claim_token IS NOT NULL
              OR candidate.claim_expires_at IS NOT NULL
            )
          ORDER BY candidate.retention_expires_at, candidate.id
          LIMIT ${input.batchLimit}
        )
      `.execute(db);

      const deletedEvents = await sql`
        DELETE FROM notification_events AS event
        WHERE event.id IN (
          SELECT candidate.id
          FROM notification_events AS candidate
          WHERE candidate.retention_expires_at <= ${input.now}
            AND NOT EXISTS (
              SELECT 1
              FROM logical_notifications AS logical
              WHERE logical.event_id = candidate.id
            )
          ORDER BY candidate.retention_expires_at, candidate.id
          LIMIT ${input.batchLimit}
        )
      `.execute(db);

      return ok({
        deliveryAttemptsDeleted: affectedRows(deliveryAttempts.numAffectedRows),
        providerWebhooksDeleted: affectedRows(providerWebhooks.numAffectedRows),
        digestMembersDeleted: affectedRows(digestMembers.numAffectedRows),
        deliveriesDeleted: affectedRows(deliveries.numAffectedRows),
        digestBatchesDeleted: affectedRows(digestBatches.numAffectedRows),
        logicalNotificationsDeleted: affectedRows(logicalNotifications.numAffectedRows),
        eventsRedacted: affectedRows(redactedEvents.numAffectedRows),
        eventsDeleted: affectedRows(deletedEvents.numAffectedRows),
      });
    } catch (error) {
      return err(
        createDatabaseError(
          error instanceof Error ? error.message : 'Failed to apply notification retention'
        )
      );
    }
  },
});
