import { describe, expect, it } from 'vitest';

import { PUBLIC_DEBATE_REQUEST_TYPE } from '@/modules/institution-correspondence/index.js';
import { ensurePublicDebateAutoSubscriptions } from '@/modules/notifications/index.js';

import { createPublicDebateNotificationHarness } from '../fixtures/public-debate-notification-harness.js';
import {
  createThreadAggregateRecord,
  createThreadRecord,
} from '../unit/institution-correspondence/fake-repo.js';

describe('public debate failed-thread notifications', () => {
  it('publishes immediate thread_failed alerts to entity subscribers and admin recipients', async () => {
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-failed',
          entityCui: '12345678',
          phase: 'failed',
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Oras Test',
            institutionEmail: 'contact@primarie.ro',
          }),
        }),
      ],
      entityNames: {
        '12345678': 'Oras Test',
      },
      auditCcRecipients: ['Review@Test.Example.com'],
    });

    await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: harness.notificationsRepo,
        hasher: {
          sha256(value: string) {
            return value;
          },
        },
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );

    const threadResult = await harness.correspondenceRepo.findThreadById('thread-failed');
    expect(threadResult.isOk()).toBe(true);
    if (threadResult.isOk()) {
      const thread = threadResult.value;
      expect(thread).not.toBeNull();
      if (thread !== null) {
        const publishResult = await harness.updatePublisher.publish({
          eventType: 'thread_failed',
          thread,
          occurredAt: new Date('2026-04-05T09:00:00.000Z'),
          failureMessage: 'Provider send failed',
        });

        expect(publishResult.isOk()).toBe(true);
        if (publishResult.isOk()) {
          expect(publishResult.value.status).toBe('queued');
          expect(publishResult.value.notificationIds).toHaveLength(1);
          expect(publishResult.value.createdOutboxIds).toHaveLength(2);
        }
      }
    }

    const entityNotificationResult = await harness.notificationsRepo.findByUserTypeAndEntity(
      'user-1',
      'funky:notification:entity_updates',
      '12345678'
    );
    expect(entityNotificationResult.isOk()).toBe(true);
    if (entityNotificationResult.isOk()) {
      expect(entityNotificationResult.value).not.toBeNull();
      if (entityNotificationResult.value !== null) {
        const entityUpdateOutbox = await harness.deliveryRepo.findByDeliveryKey(
          `user-1:${entityNotificationResult.value.id}:funky:delivery:thread_failed_thread-failed`
        );
        expect(entityUpdateOutbox.isOk()).toBe(true);
        if (entityUpdateOutbox.isOk()) {
          expect(entityUpdateOutbox.value?.notificationType).toBe('funky:outbox:entity_update');
          expect(entityUpdateOutbox.value?.metadata).not.toHaveProperty('recipientRole');
        }
      }
    }

    const adminFailureOutbox = await harness.deliveryRepo.findByDeliveryKey(
      'admin:review@test.example.com:admin_failure:thread-failed'
    );
    expect(adminFailureOutbox.isOk()).toBe(true);
    if (adminFailureOutbox.isOk()) {
      expect(adminFailureOutbox.value?.notificationType).toBe('funky:outbox:admin_failure');
    }
  });

  it('late subscribers to failed threads receive one user-facing thread_failed update without admin failure fanout', async () => {
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-failed',
          entityCui: '12345678',
          phase: 'failed',
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Oras Test',
            institutionEmail: 'contact@primarie.ro',
          }),
        }),
      ],
      entityNames: {
        '12345678': 'Oras Test',
      },
      auditCcRecipients: ['Review@Test.Example.com'],
    });

    const subscriptionResult = await harness.subscriptionService.ensureSubscribed(
      'user-1',
      '12345678'
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const entityNotificationResult = await harness.notificationsRepo.findByUserTypeAndEntity(
      'user-1',
      'funky:notification:entity_updates',
      '12345678'
    );
    expect(entityNotificationResult.isOk()).toBe(true);
    if (entityNotificationResult.isOk()) {
      expect(entityNotificationResult.value).not.toBeNull();
      if (entityNotificationResult.value !== null) {
        const entityUpdateOutbox = await harness.deliveryRepo.findByDeliveryKey(
          `user-1:${entityNotificationResult.value.id}:funky:delivery:thread_failed_thread-failed`
        );
        expect(entityUpdateOutbox.isOk()).toBe(true);
        if (entityUpdateOutbox.isOk()) {
          expect(entityUpdateOutbox.value?.notificationType).toBe('funky:outbox:entity_update');
          expect(entityUpdateOutbox.value?.metadata).not.toHaveProperty('recipientRole');
        }
      }
    }

    const adminFailureOutbox = await harness.deliveryRepo.findByDeliveryKey(
      'admin:review@test.example.com:admin_failure:thread-failed'
    );
    expect(adminFailureOutbox.isOk()).toBe(true);
    if (adminFailureOutbox.isOk()) {
      expect(adminFailureOutbox.value).toBeNull();
    }
  });
});
