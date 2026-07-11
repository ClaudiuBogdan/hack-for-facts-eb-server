import { randomUUID } from 'node:crypto';

import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import {
  buildAnonymizedUserId,
  makeUserDataAnonymizer,
  type UserDataAnonymizationAdminNotification,
} from '@/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.js';

import { dockerAvailable } from './setup.js';
import { getTestClients } from '../infra/test-db.js';

describe('User data anonymizer', () => {
  it('anonymizes user-owned PII and remains idempotent', async ({ skip }) => {
    if (!dockerAvailable) {
      skip();
    }

    const { userDb } = getTestClients();
    const logger = pinoLogger({ level: 'silent' });
    const adminNotifications: UserDataAnonymizationAdminNotification[] = [];
    const anonymizer = makeUserDataAnonymizer({
      db: userDb,
      logger,
      adminNotifier: {
        async notifyCompleted(input) {
          adminNotifications.push(input);
        },
      },
    });
    const suffix = randomUUID();
    const userId = `user-delete-${suffix}`;
    const otherUserId = `other-user-${suffix}`;
    const anonymizedUserId = buildAnonymizedUserId(userId);
    const notificationId = randomUUID();
    const outboxId = randomUUID();
    const mapId = `map-${suffix}`;
    const datasetId = randomUUID();
    const threadId = randomUUID();
    const unrelatedThreadId = randomUUID();
    const unrelatedSimilarUserId = `${userId}4`;
    const datasetRequestId = randomUUID();
    const anonymousRequestId = randomUUID();
    const agentConversationId = randomUUID();
    const agentMessageId = `agent-message-${suffix}`;
    const platformEventId = randomUUID();
    const platformSubscriptionId = randomUUID();
    const platformLogicalId = randomUUID();
    const platformDestinationId = randomUUID();
    const platformAcceptedDeliveryId = randomUUID();
    const platformRetryDeliveryId = randomUUID();
    const platformAttemptId = randomUUID();
    const platformOpenDigestId = randomUUID();
    const platformRenderedDigestId = randomUUID();

    await userDb
      .insertInto('shortlinks')
      .values([
        {
          code: `single-${suffix}`,
          user_ids: [userId],
          original_url: `https://example.test/private?email=user-${suffix}@example.com`,
          metadata: { path: '/private', query: { email: `user-${suffix}@example.com` } },
        },
        {
          code: `shared-${suffix}`,
          user_ids: [userId, otherUserId],
          original_url: `https://example.test/shared/${suffix}`,
          metadata: { path: '/shared' },
        },
      ] as never)
      .execute();

    await userDb
      .insertInto('notifications')
      .values({
        id: notificationId,
        user_id: userId,
        entity_cui: '123',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: { title: 'Personal alert', email: `user-${suffix}@example.com` },
        hash: `notification-hash-${suffix}`,
      } as never)
      .execute();

    await userDb
      .insertInto('notificationsoutbox')
      .values({
        id: outboxId,
        user_id: userId,
        notification_type: 'newsletter_entity_monthly',
        reference_id: notificationId,
        scope_key: `scope:${userId}:${suffix}`,
        delivery_key: `delivery:${userId}:${suffix}`,
        status: 'pending',
        rendered_subject: 'Personal subject',
        rendered_html: `<p>${userId}</p>`,
        rendered_text: userId,
        content_hash: `content-${suffix}`,
        template_name: 'welcome',
        template_version: '1',
        to_email: `user-${suffix}@example.com`,
        resend_email_id: `email-${suffix}`,
        metadata: {
          userId,
          email: `user-${suffix}@example.com`,
          sourceClientId: 'client-1',
        },
      } as never)
      .execute();

    await userDb
      .insertInto('userinteractions')
      .values({
        user_id: userId,
        record_key: `record-${suffix}`,
        record: {
          key: `record-${suffix}`,
          interactionId: 'custom',
          lessonId: 'lesson',
          kind: 'custom',
          scope: { type: 'global' },
          completionRule: { type: 'resolved' },
          phase: 'pending',
          value: { kind: 'text', text: { value: `private ${userId}` } },
          result: { outcome: null, feedbackText: 'private feedback', response: { userId } },
          review: {
            status: 'pending',
            reviewedAt: null,
            reviewedByUserId: userId,
          },
          sourceUrl: `https://example.test/${userId}`,
          updatedAt: new Date().toISOString(),
        },
        // Top-level arrays must be stringified: the pg driver renders JS arrays
        // as Postgres array literals, which are invalid JSON.
        audit_events: JSON.stringify([
          {
            id: `audit-${suffix}`,
            recordKey: `record-${suffix}`,
            lessonId: 'lesson',
            interactionId: 'custom',
            type: 'submitted',
            at: new Date().toISOString(),
            actor: 'user',
            value: { kind: 'text', text: { value: userId } },
            seq: '1',
            sourceClientEventId: 'event-1',
            sourceClientId: 'client-1',
          },
        ]),
      } as never)
      .execute();

    await userDb
      .insertInto('campaignnotificationrunplans')
      .values([
        {
          actor_user_id: userId,
          campaign_key: 'funky',
          runnable_id: 'runnable',
          template_id: 'template',
          template_version: '1',
          payload_hash: `payload-${suffix}`,
          watermark: 'watermark',
          summary_json: { userId },
          rows_json: JSON.stringify([{ userId, email: `user-${suffix}@example.com` }]),
          expires_at: new Date(Date.now() + 60_000),
        },
        {
          actor_user_id: otherUserId,
          campaign_key: 'funky',
          runnable_id: 'runnable',
          template_id: 'template',
          template_version: '1',
          payload_hash: `payload-unrelated-${suffix}`,
          watermark: 'watermark',
          summary_json: { userId: unrelatedSimilarUserId },
          rows_json: JSON.stringify([{ userId: unrelatedSimilarUserId }]),
          expires_at: new Date(Date.now() + 60_000),
        },
      ] as never)
      .execute();

    await userDb
      .insertInto('institutionemailthreads')
      .values([
        {
          id: threadId,
          entity_cui: '123',
          campaign_key: 'funky',
          thread_key: `thread-${suffix}`,
          phase: 'awaiting_reply',
          record: {
            version: 1,
            campaign: 'public_debate',
            campaignKey: 'funky',
            ownerUserId: userId,
            subject: `Subject ${userId}`,
            submissionPath: 'platform_send',
            institutionEmail: 'office@example.test',
            ngoIdentity: 'ngo',
            requesterOrganizationName: 'Private org',
            budgetPublicationDate: null,
            consentCapturedAt: null,
            contestationDeadlineAt: null,
            captureAddress: 'capture@example.test',
            correspondence: [
              {
                id: `entry-${suffix}`,
                campaignKey: 'funky',
                direction: 'outbound',
                source: 'platform_send',
                resendEmailId: `email-${suffix}`,
                messageId: `message-${suffix}`,
                fromAddress: `user-${suffix}@example.com`,
                toAddresses: ['office@example.test'],
                ccAddresses: [`user-${suffix}@example.com`],
                bccAddresses: [],
                subject: `Subject ${userId}`,
                textBody: `Body ${userId}`,
                htmlBody: `<p>${userId}</p>`,
                headers: { 'x-user': userId },
                attachments: [],
                occurredAt: new Date().toISOString(),
                metadata: { email: `user-${suffix}@example.com` },
              },
            ],
            latestReview: {
              basedOnEntryId: `entry-${suffix}`,
              resolutionCode: 'other',
              notes: userId,
              reviewedAt: new Date().toISOString(),
            },
            adminWorkflow: {
              currentResponseStatus: 'registration_number_received',
              responseEvents: [
                {
                  id: `response-${suffix}`,
                  responseDate: new Date().toISOString(),
                  messageContent: `Response ${userId}`,
                  responseStatus: 'registration_number_received',
                  actorUserId: userId,
                  createdAt: new Date().toISOString(),
                  source: 'campaign_admin_api',
                },
              ],
            },
            metadata: { userId, email: `user-${suffix}@example.com` },
          },
        },
        {
          id: unrelatedThreadId,
          entity_cui: '123',
          campaign_key: 'funky',
          thread_key: `thread-unrelated-${suffix}`,
          phase: 'awaiting_reply',
          record: {
            version: 1,
            campaign: 'public_debate',
            campaignKey: 'funky',
            ownerUserId: unrelatedSimilarUserId,
            subject: `Subject ${unrelatedSimilarUserId}`,
            correspondence: [],
            adminWorkflow: {
              responseEvents: [{ actorUserId: unrelatedSimilarUserId }],
            },
          },
        },
      ])
      .execute();

    await userDb
      .insertInto('resend_wh_emails')
      .values({
        svix_id: `svix-email-${suffix}`,
        event_type: 'email.delivered',
        event_created_at: new Date(),
        email_id: `email-${suffix}`,
        from_address: `user-${suffix}@example.com`,
        to_addresses: [`user-${suffix}@example.com`],
        cc_addresses: [],
        bcc_addresses: [],
        message_id: `message-${suffix}`,
        subject: `Subject ${userId}`,
        email_created_at: new Date(),
        broadcast_id: null,
        template_id: null,
        tags: JSON.stringify([{ name: 'thread_key', value: `thread-${suffix}` }]),
        attachments_json: JSON.stringify([{ filename: 'private.pdf' }]),
        bounce_type: null,
        bounce_sub_type: null,
        bounce_message: 'private bounce',
        bounce_diagnostic_code: ['private diagnostic'],
        click_ip_address: '127.0.0.1',
        click_link: `https://example.test/${userId}`,
        click_timestamp: new Date(),
        click_user_agent: 'agent',
        thread_key: `thread-${suffix}`,
        metadata: { userId, email: `user-${suffix}@example.com` },
      })
      .execute();

    await userDb
      .insertInto('advancedmapanalyticsmaps')
      .values({
        id: mapId,
        user_id: userId,
        title: `Private map ${userId}`,
        description: `Private description ${userId}`,
        visibility: 'public',
        public_id: `public-${suffix}`,
        last_snapshot: {
          title: 'Private snapshot',
          state: { note: userId },
          savedAt: new Date().toISOString(),
        },
        snapshot_count: 1,
      } as never)
      .execute();

    await userDb
      .insertInto('advancedmapanalyticssnapshots')
      .values({
        id: `snapshot-${suffix}`,
        map_id: mapId,
        title: `Snapshot ${userId}`,
        description: `Snapshot description ${userId}`,
        snapshot: {
          title: `Snapshot ${userId}`,
          state: { note: userId },
          savedAt: new Date().toISOString(),
        },
      } as never)
      .execute();

    await userDb
      .insertInto('advancedmapdatasets')
      .values({
        id: datasetId,
        public_id: randomUUID(),
        user_id: userId,
        title: `Dataset ${userId}`,
        description: `Dataset description ${userId}`,
        markdown_text: `Markdown ${userId}`,
        unit: `Unit ${userId}`,
        visibility: 'public',
      } as never)
      .execute();

    await userDb
      .insertInto('advancedmapdatasetrows')
      .values({
        dataset_id: datasetId,
        siruta_code: '123',
        value_json: { type: 'text', value: { text: `Private ${userId}` } },
      } as never)
      .execute();

    await userDb
      .insertInto('ins_dataset_requests')
      .values([
        {
          id: datasetRequestId,
          dataset_code: 'POP107D',
          siruta: '54975',
          contact_email: `user-${suffix}@example.com`,
          note: `Please load this, I am user-${suffix}`,
          clerk_user_id: userId,
        },
        {
          id: anonymousRequestId,
          dataset_code: 'POP107D',
          siruta: null,
          // The write path never persists contact_email/note without a
          // clerk_user_id, precisely because the anonymizer could not reach them.
          contact_email: null,
          note: null,
          clerk_user_id: null,
        },
      ] as never)
      .execute();

    await userDb
      .insertInto('agentconversations')
      .values({ id: agentConversationId, user_id: userId, title: `Private agent chat ${suffix}` })
      .execute();
    await userDb
      .insertInto('agentmessages')
      .values({
        id: agentMessageId,
        conversation_id: agentConversationId,
        role: 'user',
        parts: JSON.stringify([{ type: 'text', text: `Private prompt from ${userId}` }]),
      })
      .execute();

    const platformNow = new Date();
    const platformRetention = new Date(platformNow.getTime() + 365 * 24 * 60 * 60 * 1000);
    await userDb
      .insertInto('notification_events')
      .values({
        id: platformEventId,
        source: 'anonymizer-e2e',
        event_type: 'anonymizer.test.created',
        event_schema_version: 1,
        occurrence_key: `anonymizer-${suffix}`,
        occurred_at: platformNow,
        facts: { publicFact: 'preserved' },
        payload_hash: `platform-hash-${suffix}`,
        status: 'resolved',
        created_at: platformNow,
        updated_at: platformNow,
        resolved_at: platformNow,
        retention_expires_at: platformRetention,
      } as never)
      .execute();
    await userDb
      .insertInto('notification_subscriptions')
      .values({
        id: platformSubscriptionId,
        user_id: userId,
        kind_id: 'anonymizer.kind',
        subject_type: 'entity',
        subject_id: 'entity-1',
        config: { private: userId },
        normalized_key: `anonymizer:${suffix}`,
        state: 'active',
        created_at: platformNow,
        updated_at: platformNow,
      } as never)
      .execute();
    await userDb
      .insertInto('notification_global_preferences')
      .values({ user_id: userId, optional_enabled: false, updated_at: platformNow })
      .execute();
    await userDb
      .insertInto('notification_channel_preferences')
      .values({
        user_id: userId,
        channel: 'email',
        enabled: true,
        cadence: 'daily',
        updated_at: platformNow,
      })
      .execute();
    await userDb
      .insertInto('logical_notifications')
      .values({
        id: platformLogicalId,
        event_id: platformEventId,
        kind_id: 'anonymizer.kind',
        kind_version: 1,
        user_id: userId,
        eligibility_reason: 'active_subscription',
        locale: 'ro',
        recipient_facts: { private: userId },
        inbox_template_id: 'anonymizer-inbox',
        inbox_template_version: 'v1',
        inbox_title: `Private title ${userId}`,
        inbox_body: `Private body ${userId}`,
        inbox_action_url: `/private/${userId}`,
        inbox_visible: true,
        read_at: platformNow,
        archived_at: platformNow,
        created_at: platformNow,
        retention_expires_at: platformRetention,
      } as never)
      .execute();
    await userDb
      .insertInto('notification_channel_destinations')
      .values({
        id: platformDestinationId,
        user_id: userId,
        channel: 'email',
        fingerprint: `private-fingerprint-${suffix}`,
        generation: 1,
        is_current: true,
        suppressed_at: platformNow,
        suppression_reason: 'private reason',
        created_at: platformNow,
        updated_at: platformNow,
      })
      .execute();
    await userDb
      .insertInto('notification_digest_batches')
      .values([
        {
          id: platformOpenDigestId,
          user_id: userId,
          channel: 'email',
          cadence: 'daily',
          window_start_utc: new Date(platformNow.getTime() - 24 * 60 * 60 * 1000),
          window_end_utc: platformNow,
          dispatch_at_utc: platformNow,
          status: 'open',
          rendered_item_ids: null,
          overflow_count: null,
          delivery_id: null,
          claim_token: null,
          claim_expires_at: null,
          created_at: platformNow,
          updated_at: platformNow,
        },
        {
          id: platformRenderedDigestId,
          user_id: userId,
          channel: 'email',
          cadence: 'weekly',
          window_start_utc: new Date(platformNow.getTime() - 7 * 24 * 60 * 60 * 1000),
          window_end_utc: platformNow,
          dispatch_at_utc: platformNow,
          status: 'rendered',
          rendered_item_ids: JSON.stringify([platformLogicalId]),
          overflow_count: 2,
          delivery_id: null,
          claim_token: null,
          claim_expires_at: null,
          created_at: platformNow,
          updated_at: platformNow,
        },
      ] as never)
      .execute();
    await userDb
      .insertInto('notification_digest_members')
      .values([
        {
          batch_id: platformOpenDigestId,
          logical_notification_id: platformLogicalId,
          created_at: platformNow,
        },
        {
          batch_id: platformRenderedDigestId,
          logical_notification_id: platformLogicalId,
          created_at: platformNow,
        },
      ])
      .execute();
    await userDb
      .insertInto('notification_deliveries')
      .values([
        {
          id: platformAcceptedDeliveryId,
          delivery_key: `anonymizer-accepted-${suffix}`,
          logical_notification_id: platformLogicalId,
          digest_batch_id: null,
          kind_id: 'anonymizer.kind',
          user_id: userId,
          channel: 'email',
          destination_fingerprint: `private-fingerprint-${suffix}`,
          destination_generation: 1,
          template_id: 'anonymizer-email',
          template_version: 'v1',
          rendered_subject: `Private subject ${userId}`,
          rendered_html: `<p>${userId}</p>`,
          rendered_text: userId,
          content_hash: `private-content-${suffix}`,
          status: 'accepted',
          attempt_count: 1,
          provider_idempotency_key: `private-key-${suffix}`,
          provider_ref: `private-provider-${suffix}`,
          sender_mode: 'active',
          created_at: platformNow,
          updated_at: platformNow,
          accepted_at: platformNow,
          retention_expires_at: platformRetention,
        },
        {
          id: platformRetryDeliveryId,
          delivery_key: `anonymizer-retry-${suffix}`,
          logical_notification_id: null,
          digest_batch_id: platformRenderedDigestId,
          kind_id: 'anonymizer.kind',
          user_id: userId,
          channel: 'email',
          destination_fingerprint: `private-fingerprint-${suffix}`,
          destination_generation: 1,
          template_id: 'anonymizer-digest',
          template_version: 'v1',
          rendered_subject: `Private digest ${userId}`,
          rendered_html: `<p>${userId}</p>`,
          rendered_text: userId,
          content_hash: `private-digest-content-${suffix}`,
          status: 'retry_wait',
          attempt_count: 1,
          next_attempt_at: new Date(platformNow.getTime() + 60_000),
          claim_token: randomUUID(),
          claim_expires_at: new Date(platformNow.getTime() + 60_000),
          provider_idempotency_key: `private-retry-key-${suffix}`,
          last_error_code: 'private_error',
          last_error_message: `Private error ${userId}`,
          sender_mode: 'active',
          created_at: platformNow,
          updated_at: platformNow,
          retention_expires_at: platformRetention,
        },
      ] as never)
      .execute();
    await userDb
      .updateTable('notification_digest_batches')
      .set({ delivery_id: platformRetryDeliveryId })
      .where('id', '=', platformRenderedDigestId)
      .execute();
    await userDb
      .insertInto('notification_delivery_attempts')
      .values({
        id: platformAttemptId,
        delivery_id: platformAcceptedDeliveryId,
        attempt_number: 1,
        started_at: platformNow,
        completed_at: platformNow,
        provider_idempotency_key: `private-attempt-key-${suffix}`,
        destination_fingerprint: `private-fingerprint-${suffix}`,
        result: 'accepted',
        error_code: 'private_error',
        error_message: `Private error ${userId}`,
        provider_ref: `private-attempt-provider-${suffix}`,
      } as never)
      .execute();
    await userDb
      .insertInto('notification_audit_log')
      .values({
        occurred_at: platformNow,
        action: 'recipient.included',
        actor: userId,
        user_id: userId,
        event_id: platformEventId,
        logical_notification_id: platformLogicalId,
        delivery_id: platformAcceptedDeliveryId,
        batch_id: platformRenderedDigestId,
        subscription_id: platformSubscriptionId,
        reason: `Private reason ${userId}`,
        details: { private: userId },
      })
      .execute();

    const firstResult = await anonymizer.anonymizeDeletedUser({
      userId,
      svixId: `svix-delete-${suffix}`,
      eventType: 'user.deleted',
      eventTimestamp: Date.now(),
    });
    expect(firstResult.isOk()).toBe(true);
    if (firstResult.isOk()) {
      expect(firstResult.value.agentConversationsDeleted).toBe(1);
    }

    const replayResult = await anonymizer.anonymizeDeletedUser({
      userId,
      svixId: `svix-delete-replay-${suffix}`,
      eventType: 'user.deleted',
      eventTimestamp: Date.now(),
    });
    expect(replayResult.isOk()).toBe(true);

    const rowsWithOriginalUserId = await userDb
      .selectFrom('notifications')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(rowsWithOriginalUserId.count).toBe('0');

    const notification = await userDb
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', notificationId)
      .executeTakeFirstOrThrow();
    expect(notification.user_id).toBe(anonymizedUserId);
    expect(notification.is_active).toBe(false);
    expect(notification.hash).toBe(`anonymized:${notificationId}`);

    const outbox = await userDb
      .selectFrom('notificationsoutbox')
      .selectAll()
      .where('id', '=', outboxId)
      .executeTakeFirstOrThrow();
    expect(outbox.user_id).toBe(anonymizedUserId);
    expect(outbox.to_email).toBeNull();
    expect(outbox.rendered_html).toBeNull();
    expect(outbox.delivery_key).toBe(`anonymized:${outboxId}`);
    expect(outbox.metadata).toMatchObject({ userId: anonymizedUserId, email: null });
    expect(JSON.stringify(outbox.metadata)).not.toContain(userId);

    const interaction = await userDb
      .selectFrom('userinteractions')
      .selectAll()
      .where('user_id', '=', anonymizedUserId)
      .where('record_key', '=', `record-${suffix}`)
      .executeTakeFirstOrThrow();
    expect(interaction.record).toMatchObject({
      value: null,
      review: { status: 'pending' },
    });
    expect(JSON.stringify(interaction.record)).not.toContain(userId);
    expect(interaction.audit_events).toEqual([]);

    const thread = await userDb
      .selectFrom('institutionemailthreads')
      .selectAll()
      .where('id', '=', threadId)
      .executeTakeFirstOrThrow();
    expect(thread.record).toMatchObject({
      ownerUserId: anonymizedUserId,
      requesterOrganizationName: null,
      correspondence: [
        {
          fromAddress: 'redacted@example.invalid',
          toAddresses: [],
          textBody: null,
          htmlBody: null,
        },
      ],
    });
    expect(JSON.stringify(thread.record)).not.toContain(userId);

    const unrelatedThread = await userDb
      .selectFrom('institutionemailthreads')
      .selectAll()
      .where('id', '=', unrelatedThreadId)
      .executeTakeFirstOrThrow();
    expect(unrelatedThread.record).toMatchObject({
      ownerUserId: unrelatedSimilarUserId,
      subject: `Subject ${unrelatedSimilarUserId}`,
    });

    const unrelatedPlan = await userDb
      .selectFrom('campaignnotificationrunplans')
      .selectAll()
      .where('payload_hash', '=', `payload-unrelated-${suffix}`)
      .executeTakeFirst();
    expect(unrelatedPlan).toBeDefined();

    const resendEvent = await userDb
      .selectFrom('resend_wh_emails')
      .selectAll()
      .where('email_id', '=', `email-${suffix}`)
      .executeTakeFirstOrThrow();
    expect(resendEvent.from_address).toBe('redacted@example.invalid');
    expect(resendEvent.to_addresses).toEqual([]);
    expect(resendEvent.attachments_json).toBeNull();
    expect(resendEvent.click_ip_address).toBeNull();
    expect(resendEvent.click_user_agent).toBeNull();
    expect(JSON.stringify(resendEvent.metadata)).not.toContain(userId);

    const map = await userDb
      .selectFrom('advancedmapanalyticsmaps')
      .selectAll()
      .where('id', '=', mapId)
      .executeTakeFirstOrThrow();
    expect(map.user_id).toBe(anonymizedUserId);
    expect(map.title).toBe('Deleted user map');
    expect(map.description).toBeNull();
    expect(map.public_id).toBeNull();
    expect(map.deleted_at).not.toBeNull();

    const dataset = await userDb
      .selectFrom('advancedmapdatasets')
      .selectAll()
      .where('id', '=', datasetId)
      .executeTakeFirstOrThrow();
    expect(dataset.user_id).toBe(anonymizedUserId);
    expect(dataset.title).toBe('Deleted user dataset');
    expect(dataset.markdown_text).toBeNull();
    expect(dataset.row_count).toBe(0);
    expect(dataset.deleted_at).not.toBeNull();

    const datasetRequest = await userDb
      .selectFrom('ins_dataset_requests')
      .selectAll()
      .where('id', '=', datasetRequestId)
      .executeTakeFirstOrThrow();
    expect(datasetRequest.clerk_user_id).toBe(anonymizedUserId);
    expect(datasetRequest.contact_email).toBeNull();
    expect(datasetRequest.note).toBeNull();
    // The aggregate demand signal survives.
    expect(datasetRequest.dataset_code).toBe('POP107D');
    expect(datasetRequest.siruta).toBe('54975');

    // An anonymous row holds no PII to begin with, and the anonymizer leaves it
    // alone; only its aggregate signal remains.
    const anonymousRequest = await userDb
      .selectFrom('ins_dataset_requests')
      .selectAll()
      .where('id', '=', anonymousRequestId)
      .executeTakeFirstOrThrow();
    expect(anonymousRequest.clerk_user_id).toBeNull();
    expect(anonymousRequest.contact_email).toBeNull();
    expect(anonymousRequest.note).toBeNull();
    expect(anonymousRequest.dataset_code).toBe('POP107D');

    const deletedAgentConversation = await userDb
      .selectFrom('agentconversations')
      .select('id')
      .where('id', '=', agentConversationId)
      .executeTakeFirst();
    expect(deletedAgentConversation).toBeUndefined();

    const deletedAgentMessage = await userDb
      .selectFrom('agentmessages')
      .select('id')
      .where('id', '=', agentMessageId)
      .executeTakeFirst();
    expect(deletedAgentMessage).toBeUndefined();

    const platformEvent = await userDb
      .selectFrom('notification_events')
      .selectAll()
      .where('id', '=', platformEventId)
      .executeTakeFirstOrThrow();
    expect(platformEvent.facts).toEqual({ publicFact: 'preserved' });

    const platformSubscriptions = await userDb
      .selectFrom('notification_subscriptions')
      .selectAll()
      .where('user_id', 'in', [userId, anonymizedUserId])
      .execute();
    expect(platformSubscriptions).toEqual([]);
    const platformGlobalPreferences = await userDb
      .selectFrom('notification_global_preferences')
      .selectAll()
      .where('user_id', 'in', [userId, anonymizedUserId])
      .execute();
    expect(platformGlobalPreferences).toEqual([]);
    const platformChannelPreferences = await userDb
      .selectFrom('notification_channel_preferences')
      .selectAll()
      .where('user_id', 'in', [userId, anonymizedUserId])
      .execute();
    expect(platformChannelPreferences).toEqual([]);
    const platformDestination = await userDb
      .selectFrom('notification_channel_destinations')
      .select('id')
      .where('id', '=', platformDestinationId)
      .executeTakeFirst();
    expect(platformDestination).toBeUndefined();

    const platformLogical = await userDb
      .selectFrom('logical_notifications')
      .selectAll()
      .where('id', '=', platformLogicalId)
      .executeTakeFirstOrThrow();
    expect(platformLogical).toMatchObject({
      user_id: anonymizedUserId,
      eligibility_reason: 'user_anonymized',
      recipient_facts: null,
      inbox_title: 'Notification unavailable',
      inbox_body: '',
      inbox_action_url: null,
      inbox_visible: false,
      read_at: null,
      archived_at: null,
    });

    const platformAcceptedDelivery = await userDb
      .selectFrom('notification_deliveries')
      .selectAll()
      .where('id', '=', platformAcceptedDeliveryId)
      .executeTakeFirstOrThrow();
    expect(platformAcceptedDelivery).toMatchObject({
      user_id: anonymizedUserId,
      status: 'accepted',
      destination_fingerprint: null,
      destination_generation: null,
      rendered_subject: null,
      rendered_html: null,
      rendered_text: null,
      content_hash: null,
      provider_idempotency_key: null,
      provider_ref: null,
      claim_token: null,
      claim_expires_at: null,
    });
    const platformRetryDelivery = await userDb
      .selectFrom('notification_deliveries')
      .selectAll()
      .where('id', '=', platformRetryDeliveryId)
      .executeTakeFirstOrThrow();
    expect(platformRetryDelivery).toMatchObject({
      user_id: anonymizedUserId,
      status: 'cancelled',
      last_error_code: 'user_anonymized',
      last_error_message: null,
      claim_token: null,
      claim_expires_at: null,
    });
    expect(platformRetryDelivery.terminal_at).not.toBeNull();

    const platformAttempt = await userDb
      .selectFrom('notification_delivery_attempts')
      .selectAll()
      .where('id', '=', platformAttemptId)
      .executeTakeFirstOrThrow();
    expect(platformAttempt).toMatchObject({
      destination_fingerprint: null,
      error_code: null,
      error_message: null,
      provider_ref: null,
      result: 'accepted',
    });

    const platformOpenDigest = await userDb
      .selectFrom('notification_digest_batches')
      .selectAll()
      .where('id', '=', platformOpenDigestId)
      .executeTakeFirstOrThrow();
    expect(platformOpenDigest).toMatchObject({
      user_id: anonymizedUserId,
      status: 'cancelled',
      rendered_item_ids: [],
      overflow_count: null,
      claim_token: null,
      claim_expires_at: null,
    });
    const platformRenderedDigest = await userDb
      .selectFrom('notification_digest_batches')
      .selectAll()
      .where('id', '=', platformRenderedDigestId)
      .executeTakeFirstOrThrow();
    expect(platformRenderedDigest).toMatchObject({
      user_id: anonymizedUserId,
      status: 'rendered',
      rendered_item_ids: [],
      overflow_count: null,
      delivery_id: platformRetryDeliveryId,
    });
    const platformMembers = await userDb
      .selectFrom('notification_digest_members')
      .selectAll()
      .where('logical_notification_id', '=', platformLogicalId)
      .execute();
    expect(platformMembers).toHaveLength(2);

    const platformAudit = await userDb
      .selectFrom('notification_audit_log')
      .selectAll()
      .where('event_id', '=', platformEventId)
      .executeTakeFirstOrThrow();
    expect(platformAudit).toMatchObject({
      user_id: anonymizedUserId,
      actor: anonymizedUserId,
      reason: null,
      details: {},
    });

    const datasetRows = await userDb
      .selectFrom('advancedmapdatasetrows')
      .selectAll()
      .where('dataset_id', '=', datasetId)
      .execute();
    expect(datasetRows).toEqual([]);

    const sharedShortLink = await userDb
      .selectFrom('shortlinks')
      .select(['user_ids'])
      .where('code', '=', `shared-${suffix}`)
      .executeTakeFirstOrThrow();
    expect(sharedShortLink.user_ids).toEqual([otherUserId]);

    const singleShortLink = await userDb
      .selectFrom('shortlinks')
      .selectAll()
      .where('code', '=', `single-${suffix}`)
      .executeTakeFirst();
    expect(singleShortLink).toBeUndefined();

    const auditRow = await userDb
      .selectFrom('userdataanonymizationaudit')
      .selectAll()
      .where('anonymized_user_id', '=', anonymizedUserId)
      .executeTakeFirstOrThrow();
    expect(auditRow.user_id_hash).not.toBe(userId);
    expect(auditRow.latest_svix_id).toBe(`svix-delete-replay-${suffix}`);
    expect(auditRow.run_count).toBe(2);

    expect(adminNotifications).toHaveLength(2);
    expect(adminNotifications[0]?.userIdHash).not.toBe(userId);
    expect(adminNotifications[0]?.anonymizedUserId).toBe(anonymizedUserId);
    expect(JSON.stringify(adminNotifications)).not.toContain(userId);
  });
});
