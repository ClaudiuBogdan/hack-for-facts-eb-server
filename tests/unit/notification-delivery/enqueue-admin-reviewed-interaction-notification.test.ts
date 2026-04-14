import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  buildAdminReviewedInteractionDeliveryKey,
  enqueueAdminReviewedInteractionNotification,
} from '@/modules/notification-delivery/index.js';

import {
  createTestDeliveryRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';

describe('enqueueAdminReviewedInteractionNotification', () => {
  // This suite covers the downstream delivery helper after an upstream caller
  // has already opted in to reviewed-interaction delivery. The admin review
  // route default remains "save review only" unless `send_notification = true`.
  const createComposeJobScheduler = () => ({
    enqueue: vi.fn(async () => ok(undefined)),
  });

  const baseInput = {
    runId: 'run-1',
    userId: 'user-1',
    entityCui: '12345678',
    entityName: 'Municipiul Exemplu',
    recordKey: 'record-1',
    interactionId: 'funky:interaction:budget_document',
    interactionLabel: 'Document buget',
    reviewStatus: 'rejected' as const,
    reviewedAt: '2026-04-13T12:00:00.000Z',
    feedbackText: 'Documentul trimis nu este suficient de clar.',
    nextStepLinks: [
      {
        kind: 'retry_interaction' as const,
        label: 'Revino la pasul pentru documentul de buget',
        url: 'https://example.invalid/retry',
      },
    ],
    triggerSource: 'campaign_admin',
    triggeredByUserId: 'admin-1',
  };

  it('creates and queues a reviewed interaction outbox row when the user is eligible', async () => {
    const notification = createTestNotification({
      id: 'notif-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const result = await enqueueAdminReviewedInteractionNotification(
      {
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [notification],
        }),
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('queued');
      expect(result.value.reason).toBe('eligible_now');
      expect(result.value.source).toBe('created');
    }

    const outbox = await deliveryRepo.findByDeliveryKey(
      buildAdminReviewedInteractionDeliveryKey({
        campaignKey: 'funky',
        userId: baseInput.userId,
        interactionId: baseInput.interactionId,
        recordKey: baseInput.recordKey,
        reviewedAt: baseInput.reviewedAt,
        reviewStatus: baseInput.reviewStatus,
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.notificationType).toBe('funky:outbox:admin_reviewed_interaction');
      expect(outbox.value?.metadata).toEqual(
        expect.objectContaining({
          familyId: 'admin_reviewed_interaction',
          interactionId: baseInput.interactionId,
          reviewStatus: baseInput.reviewStatus,
          entityCui: baseInput.entityCui,
        })
      );
    }
  });

  it('returns dry_run without creating an outbox row', async () => {
    const notification = createTestNotification({
      id: 'notif-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueueAdminReviewedInteractionNotification(
      {
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [notification],
        }),
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        ...baseInput,
        dryRun: true,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('dry_run');
      expect(result.value.reason).toBe('eligible_now');
      expect(result.value.source).toBe('created');
    }

    const outbox = await deliveryRepo.findByDeliveryKey(
      buildAdminReviewedInteractionDeliveryKey({
        campaignKey: 'funky',
        userId: baseInput.userId,
        interactionId: baseInput.interactionId,
        recordKey: baseInput.recordKey,
        reviewedAt: baseInput.reviewedAt,
        reviewStatus: baseInput.reviewStatus,
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value).toBeNull();
    }
  });

  it('skips when no eligible preference exists', async () => {
    const result = await enqueueAdminReviewedInteractionNotification(
      {
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        deliveryRepo: makeFakeDeliveryRepo(),
        composeJobScheduler: createComposeJobScheduler(),
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('skipped');
      expect(result.value.reason).toBe('ineligible_now');
    }
  });

  it('skips when the campaign-level preference disables entity updates', async () => {
    const entityNotification = createTestNotification({
      id: 'notif-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
      isActive: true,
    });
    const campaignGlobal = createTestNotification({
      id: 'notif-global',
      userId: 'user-1',
      entityCui: null,
      notificationType: 'funky:notification:global',
      isActive: false,
    });

    const result = await enqueueAdminReviewedInteractionNotification(
      {
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [entityNotification, campaignGlobal],
        }),
        deliveryRepo: makeFakeDeliveryRepo(),
        composeJobScheduler: createComposeJobScheduler(),
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('skipped');
      expect(result.value.reason).toBe('ineligible_now');
      expect(result.value.eligibility.reason).toBe('campaign_disabled');
    }
  });

  it('skips a delivered existing occurrence instead of resending it', async () => {
    const notification = createTestNotification({
      id: 'notif-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const deliveryKey = buildAdminReviewedInteractionDeliveryKey({
      campaignKey: 'funky',
      userId: baseInput.userId,
      interactionId: baseInput.interactionId,
      recordKey: baseInput.recordKey,
      reviewedAt: baseInput.reviewedAt,
      reviewStatus: baseInput.reviewStatus,
    });
    const existingOutbox = createTestDeliveryRecord({
      id: 'outbox-1',
      userId: 'user-1',
      notificationType: 'funky:outbox:admin_reviewed_interaction',
      referenceId: notification.id,
      scopeKey: deliveryKey,
      deliveryKey,
      status: 'delivered',
      metadata: {
        familyId: 'admin_reviewed_interaction',
      },
    });

    const result = await enqueueAdminReviewedInteractionNotification(
      {
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [notification],
        }),
        deliveryRepo: makeFakeDeliveryRepo({ deliveries: [existingOutbox] }),
        composeJobScheduler: createComposeJobScheduler(),
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('skipped');
      expect(result.value.reason).toBe('existing_sent');
      expect(result.value.outboxId).toBe(existingOutbox.id);
    }
  });
});
