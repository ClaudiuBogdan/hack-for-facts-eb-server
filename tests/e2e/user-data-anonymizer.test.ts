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
  it('anonymizes user-owned PII and remains idempotent', async () => {
    if (!dockerAvailable) {
      return;
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
        audit_events: [
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
        ],
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
          rows_json: [{ userId, email: `user-${suffix}@example.com` }],
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
          rows_json: [{ userId: unrelatedSimilarUserId }],
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
        tags: [{ name: 'thread_key', value: `thread-${suffix}` }],
        attachments_json: [{ filename: 'private.pdf' }],
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
      } as never)
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

    const firstResult = await anonymizer.anonymizeDeletedUser({
      userId,
      svixId: `svix-delete-${suffix}`,
      eventType: 'user.deleted',
      eventTimestamp: Date.now(),
    });
    expect(firstResult.isOk()).toBe(true);

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
