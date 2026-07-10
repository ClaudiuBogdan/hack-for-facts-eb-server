import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  makeRetentionRunner,
  type RetentionSummary,
} from '@/modules/notification-platform/shell/retention/apply-retention.js';

import { truncatePlatformTables } from './contract-db.js';
import { getTestClients } from '../../infra/test-db.js';
import { dockerAvailable } from '../setup.js';

const total = (summaries: RetentionSummary[], field: keyof RetentionSummary): number =>
  summaries.reduce((sum, summary) => sum + summary[field], 0);

describe('notification platform retention', () => {
  it('deletes expired user-linked rows, preserves audit, and leaves fresh rows untouched', async ({
    skip,
  }) => {
    if (!dockerAvailable) {
      skip();
    }

    const { userDb } = getTestClients();
    await truncatePlatformTables(userDb);

    const suffix = randomUUID();
    const now = new Date('2028-07-10T09:00:00.000Z');
    const oldAt = new Date('2025-01-10T09:00:00.000Z');
    const freshAt = new Date('2028-07-01T09:00:00.000Z');
    const expiredAt = new Date('2028-01-10T09:00:00.000Z');
    const retainedUntil = new Date('2030-07-10T09:00:00.000Z');
    const expiredEventId = randomUUID();
    const failedEventId = randomUUID();
    const conflictedEventId = randomUUID();
    const referencedExpiredEventId = randomUUID();
    const freshEventId = randomUUID();
    const expiredLogicalId = randomUUID();
    const retainedLogicalId = randomUUID();
    const freshLogicalId = randomUUID();
    const expiredDeliveryId = randomUUID();
    const freshDeliveryId = randomUUID();
    const expiredBatchId = randomUUID();
    const oldWebhookIds = [`retention-old-a-${suffix}`, `retention-old-b-${suffix}`];
    const freshWebhookId = `retention-fresh-${suffix}`;

    try {
      await userDb
        .insertInto('notification_events')
        .values(
          [
            [expiredEventId, 'resolved', expiredAt, { privateContent: 'delete with logical' }],
            [failedEventId, 'failed', expiredAt, { privateContent: 'delete failed' }],
            [conflictedEventId, 'conflicted', expiredAt, { privateContent: 'delete conflicted' }],
            [
              referencedExpiredEventId,
              'resolved',
              expiredAt,
              { privateContent: 'scrub while referenced' },
            ],
            [freshEventId, 'resolved', retainedUntil, { content: 'keep me' }],
          ].map(([id, status, retentionExpiresAt, facts], index) => ({
            id: id as string,
            source: 'retention',
            event_type: `retention.event.${String(index)}`,
            event_schema_version: 1,
            occurrence_key: `${String(index)}-${suffix}`,
            occurred_at: index === 4 ? freshAt : oldAt,
            facts: facts as Record<string, unknown>,
            payload_hash: `hash-${String(index)}-${suffix}`,
            correlation_id: index === 3 ? `correlation-${suffix}` : null,
            causation_id: index === 3 ? `causation-${suffix}` : null,
            stream_key: null,
            stream_sequence: null,
            status: status as 'resolved' | 'failed' | 'conflicted',
            resolution_cursor: status === 'resolved' ? 'finished' : null,
            claim_token: null,
            claim_expires_at: null,
            created_at: index === 4 ? freshAt : oldAt,
            updated_at: index === 4 ? freshAt : oldAt,
            resolved_at: status === 'resolved' ? (index === 4 ? freshAt : oldAt) : null,
            retention_expires_at: retentionExpiresAt as Date,
          }))
        )
        .execute();

      await userDb
        .insertInto('logical_notifications')
        .values([
          {
            id: expiredLogicalId,
            event_id: expiredEventId,
            kind_id: 'retention.kind',
            kind_version: 1,
            user_id: `expired-user-${suffix}`,
            eligibility_reason: 'active_subscription',
            locale: 'ro',
            recipient_facts: { personal: 'delete me' },
            inbox_template_id: 'retention',
            inbox_template_version: 'v1',
            inbox_title: 'Expired title',
            inbox_body: 'Expired body',
            inbox_action_url: 'https://example.test/expired',
            inbox_visible: true,
            read_at: oldAt,
            archived_at: null,
            stream_key: null,
            stream_sequence: null,
            created_at: oldAt,
            retention_expires_at: expiredAt,
          },
          {
            id: retainedLogicalId,
            event_id: referencedExpiredEventId,
            kind_id: 'retention.kind',
            kind_version: 1,
            user_id: `retained-user-${suffix}`,
            eligibility_reason: 'active_subscription',
            locale: 'ro',
            recipient_facts: { content: 'keep logical' },
            inbox_template_id: 'retention',
            inbox_template_version: 'v1',
            inbox_title: 'Retained title',
            inbox_body: 'Retained body',
            inbox_action_url: null,
            inbox_visible: true,
            read_at: null,
            archived_at: null,
            stream_key: null,
            stream_sequence: null,
            created_at: freshAt,
            retention_expires_at: retainedUntil,
          },
          {
            id: freshLogicalId,
            event_id: freshEventId,
            kind_id: 'retention.kind',
            kind_version: 1,
            user_id: `fresh-user-${suffix}`,
            eligibility_reason: 'active_subscription',
            locale: 'ro',
            recipient_facts: { content: 'keep me' },
            inbox_template_id: 'retention',
            inbox_template_version: 'v1',
            inbox_title: 'Fresh title',
            inbox_body: 'Fresh body',
            inbox_action_url: 'https://example.test/fresh',
            inbox_visible: true,
            read_at: null,
            archived_at: null,
            stream_key: null,
            stream_sequence: null,
            created_at: freshAt,
            retention_expires_at: retainedUntil,
          },
        ])
        .execute();

      await userDb
        .insertInto('notification_deliveries')
        .values(
          [
            [expiredDeliveryId, expiredLogicalId, expiredAt, oldAt, 'expired'],
            [freshDeliveryId, freshLogicalId, retainedUntil, freshAt, 'fresh'],
          ].map(([id, logicalId, retentionExpiresAt, createdAt, label]) => ({
            id: id as string,
            delivery_key: `${label as string}-delivery-${suffix}`,
            logical_notification_id: logicalId as string,
            digest_batch_id: null,
            kind_id: 'retention.kind',
            user_id: `${label as string}-user-${suffix}`,
            channel: 'email' as const,
            destination_fingerprint: `${label as string}-fingerprint-${suffix}`,
            destination_generation: 1,
            template_id: 'retention',
            template_version: 'v1',
            rendered_subject: `${label as string} subject`,
            rendered_html: `<p>${label as string} body</p>`,
            rendered_text: `${label as string} body`,
            content_hash: `${label as string}-hash-${suffix}`,
            status: 'delivered' as const,
            not_before: null,
            expires_at: null,
            stream_key: null,
            stream_sequence: null,
            attempt_count: 1,
            next_attempt_at: null,
            claim_token: null,
            claim_expires_at: null,
            provider_idempotency_key: id as string,
            provider_ref: `${label as string}-provider-${suffix}`,
            last_error_code: null,
            last_error_message: null,
            sender_mode: 'active' as const,
            created_at: createdAt as Date,
            updated_at: createdAt as Date,
            accepted_at: createdAt as Date,
            terminal_at: createdAt as Date,
            retention_expires_at: retentionExpiresAt as Date,
          }))
        )
        .execute();

      await userDb
        .insertInto('notification_delivery_attempts')
        .values(
          [
            [expiredDeliveryId, oldAt, 'expired'],
            [freshDeliveryId, freshAt, 'fresh'],
          ].map(([deliveryId, createdAt, label]) => ({
            id: randomUUID(),
            delivery_id: deliveryId as string,
            attempt_number: 1,
            started_at: createdAt as Date,
            completed_at: createdAt as Date,
            provider_idempotency_key: deliveryId as string,
            request_correlation_id: null,
            destination_fingerprint: `${label as string}-fingerprint-${suffix}`,
            result: 'accepted' as const,
            error_code: null,
            error_message: null,
            provider_ref: `${label as string}-provider-${suffix}`,
            latency_ms: 100,
            retry_after_ms: null,
            created_at: createdAt as Date,
          }))
        )
        .execute();

      await userDb
        .insertInto('notification_digest_batches')
        .values({
          id: expiredBatchId,
          user_id: `expired-user-${suffix}`,
          channel: 'email',
          cadence: 'daily',
          window_start_utc: new Date('2025-01-09T06:00:00.000Z'),
          window_end_utc: new Date('2025-01-10T06:00:00.000Z'),
          dispatch_at_utc: new Date('2025-01-10T06:00:00.000Z'),
          status: 'rendered',
          rendered_item_ids: [expiredLogicalId],
          overflow_count: 0,
          delivery_id: null,
          claim_token: null,
          claim_expires_at: null,
          created_at: oldAt,
          updated_at: oldAt,
        })
        .execute();
      await userDb
        .insertInto('notification_digest_members')
        .values({
          batch_id: expiredBatchId,
          logical_notification_id: expiredLogicalId,
          created_at: oldAt,
        })
        .execute();

      await userDb
        .insertInto('notification_audit_log')
        .values({
          occurred_at: oldAt,
          action: 'delivery.terminal',
          actor: 'system',
          user_id: `expired-user-${suffix}`,
          event_id: expiredEventId,
          logical_notification_id: expiredLogicalId,
          delivery_id: expiredDeliveryId,
          batch_id: expiredBatchId,
          subscription_id: null,
          reason: 'delivered',
          details: { permanent: true },
        })
        .execute();

      const webhookRows = [
        ...oldWebhookIds.map((svixId, index) => ({
          svix_id: svixId,
          event_type: 'email.delivered',
          webhook_received_at: new Date(oldAt.getTime() + index),
          event_created_at: oldAt,
          email_id: `old-email-${String(index)}-${suffix}`,
          from_address: 'private-sender@example.test',
          to_addresses: ['private-recipient@example.test'],
          message_id: null,
          subject: 'Private raw payload',
          email_created_at: oldAt,
          broadcast_id: null,
          template_id: null,
          tags: null,
          attachments_json: null,
          bounce_type: null,
          bounce_sub_type: null,
          bounce_message: null,
          bounce_diagnostic_code: null,
          click_ip_address: null,
          click_link: null,
          click_timestamp: null,
          click_user_agent: null,
          thread_key: null,
          metadata: {},
        })),
        {
          svix_id: freshWebhookId,
          event_type: 'email.delivered',
          webhook_received_at: freshAt,
          event_created_at: freshAt,
          email_id: `fresh-email-${suffix}`,
          from_address: 'sender@example.test',
          to_addresses: ['recipient@example.test'],
          message_id: null,
          subject: 'Fresh raw payload',
          email_created_at: freshAt,
          broadcast_id: null,
          template_id: null,
          tags: null,
          attachments_json: null,
          bounce_type: null,
          bounce_sub_type: null,
          bounce_message: null,
          bounce_diagnostic_code: null,
          click_ip_address: null,
          click_link: null,
          click_timestamp: null,
          click_user_agent: null,
          thread_key: null,
          metadata: {},
        },
      ];
      await userDb
        .insertInto('resend_wh_emails')
        .values(webhookRows as never)
        .execute();

      const runner = makeRetentionRunner(userDb);
      const summaries: RetentionSummary[] = [];
      for (let pass = 0; pass < 10; pass += 1) {
        const result = await runner.applyRetention({ batchLimit: 1, now });
        expect(result.isOk()).toBe(true);
        if (result.isErr()) {
          break;
        }
        summaries.push(result.value);
        if (Object.values(result.value).every((count) => count === 0)) {
          break;
        }
      }

      expect(summaries.at(-1)).toEqual({
        deliveryAttemptsDeleted: 0,
        providerWebhooksDeleted: 0,
        digestMembersDeleted: 0,
        deliveriesDeleted: 0,
        digestBatchesDeleted: 0,
        logicalNotificationsDeleted: 0,
        eventsRedacted: 0,
        eventsDeleted: 0,
      });
      expect(total(summaries, 'deliveryAttemptsDeleted')).toBe(1);
      expect(total(summaries, 'providerWebhooksDeleted')).toBe(2);
      expect(total(summaries, 'digestMembersDeleted')).toBe(1);
      expect(total(summaries, 'deliveriesDeleted')).toBe(1);
      expect(total(summaries, 'digestBatchesDeleted')).toBe(1);
      expect(total(summaries, 'logicalNotificationsDeleted')).toBe(1);
      expect(total(summaries, 'eventsRedacted')).toBe(1);
      expect(total(summaries, 'eventsDeleted')).toBe(3);

      expect(
        await userDb
          .selectFrom('notification_deliveries')
          .select('id')
          .where('id', '=', expiredDeliveryId)
          .executeTakeFirst()
      ).toBeUndefined();
      expect(
        await userDb
          .selectFrom('logical_notifications')
          .select('id')
          .where('id', '=', expiredLogicalId)
          .executeTakeFirst()
      ).toBeUndefined();
      expect(
        await userDb
          .selectFrom('notification_digest_batches')
          .select('id')
          .where('id', '=', expiredBatchId)
          .executeTakeFirst()
      ).toBeUndefined();

      const deletedEventIds = [expiredEventId, failedEventId, conflictedEventId];
      expect(
        await userDb
          .selectFrom('notification_events')
          .select('id')
          .where('id', 'in', deletedEventIds)
          .execute()
      ).toEqual([]);
      expect(
        await userDb
          .selectFrom('notification_events')
          .select(['facts', 'correlation_id', 'causation_id'])
          .where('id', '=', referencedExpiredEventId)
          .executeTakeFirstOrThrow()
      ).toEqual({ facts: {}, correlation_id: null, causation_id: null });

      expect(
        await userDb
          .selectFrom('notification_audit_log')
          .select(['action', 'user_id', 'details'])
          .where('delivery_id', '=', expiredDeliveryId)
          .executeTakeFirstOrThrow()
      ).toEqual({
        action: 'delivery.terminal',
        user_id: `expired-user-${suffix}`,
        details: { permanent: true },
      });

      expect(
        await userDb
          .selectFrom('notification_deliveries')
          .select(['rendered_subject', 'provider_ref', 'destination_fingerprint'])
          .where('id', '=', freshDeliveryId)
          .executeTakeFirstOrThrow()
      ).toEqual({
        rendered_subject: 'fresh subject',
        provider_ref: `fresh-provider-${suffix}`,
        destination_fingerprint: `fresh-fingerprint-${suffix}`,
      });
      expect(
        await userDb
          .selectFrom('logical_notifications')
          .select(['inbox_title', 'inbox_body', 'recipient_facts'])
          .where('id', '=', retainedLogicalId)
          .executeTakeFirstOrThrow()
      ).toEqual({
        inbox_title: 'Retained title',
        inbox_body: 'Retained body',
        recipient_facts: { content: 'keep logical' },
      });
      expect(
        await userDb
          .selectFrom('notification_events')
          .select('facts')
          .where('id', '=', freshEventId)
          .executeTakeFirstOrThrow()
      ).toEqual({ facts: { content: 'keep me' } });
      expect(
        await userDb
          .selectFrom('notification_delivery_attempts')
          .select('delivery_id')
          .where('delivery_id', '=', freshDeliveryId)
          .execute()
      ).toEqual([{ delivery_id: freshDeliveryId }]);
      expect(
        await userDb
          .selectFrom('resend_wh_emails')
          .select('svix_id')
          .where('svix_id', 'in', [...oldWebhookIds, freshWebhookId])
          .execute()
      ).toEqual([{ svix_id: freshWebhookId }]);
    } finally {
      await userDb
        .deleteFrom('resend_wh_emails')
        .where('svix_id', 'in', [...oldWebhookIds, freshWebhookId])
        .execute();
      await truncatePlatformTables(userDb);
    }
  });
});
