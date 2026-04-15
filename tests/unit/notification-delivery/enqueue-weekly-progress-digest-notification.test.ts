import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  buildWeeklyProgressDigestDeliveryKey,
  enqueueWeeklyProgressDigestNotification,
} from '@/modules/notification-delivery/index.js';

import {
  createTestDeliveryRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';

describe('enqueueWeeklyProgressDigestNotification', () => {
  const createComposeJobScheduler = () => ({
    enqueue: vi.fn(async () => ok(undefined)),
  });

  const baseInput = {
    runId: 'run-1',
    userId: 'user-1',
    weekKey: '2026-W16',
    periodLabel: '7 aprilie - 13 aprilie',
    watermarkAt: '2026-04-15T09:00:00.000Z',
    summary: {
      totalItemCount: 1,
      visibleItemCount: 1,
      hiddenItemCount: 0,
      actionNowCount: 1,
      approvedCount: 0,
      rejectedCount: 1,
      pendingCount: 0,
      draftCount: 0,
      failedCount: 0,
    },
    items: [
      {
        itemKey: 'item-1',
        interactionId: 'funky:interaction:budget_document',
        interactionLabel: 'Documentul de buget',
        entityName: 'Municipiul Exemplu',
        statusLabel: 'Mai are nevoie de o corectură',
        statusTone: 'danger' as const,
        title: 'Documentul de buget trebuie corectat',
        description: 'Am găsit o problemă care te împiedică să mergi mai departe.',
        updatedAt: '2026-04-15T08:00:00.000Z',
        feedbackSnippet: 'Fișierul trimis nu conține proiectul complet.',
        actionLabel: 'Corectează documentul',
        actionUrl: 'https://transparenta.eu/cta/document',
      },
    ],
    primaryCta: {
      label: 'Corectează documentul',
      url: 'https://transparenta.eu/cta/document',
    },
    secondaryCtas: [
      {
        label: 'Vezi provocarea',
        url: 'https://transparenta.eu/primarie/12345678',
      },
    ],
    allUpdatesUrl: null,
    triggerSource: 'campaign_admin',
    triggeredByUserId: 'admin-1',
  };

  it('creates and queues a weekly progress digest outbox row when the user is eligible', async () => {
    const notification = createTestNotification({
      id: 'notif-global-1',
      userId: 'user-1',
      entityCui: null,
      notificationType: 'funky:notification:global',
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueueWeeklyProgressDigestNotification(
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
      buildWeeklyProgressDigestDeliveryKey({
        userId: baseInput.userId,
        weekKey: baseInput.weekKey,
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.notificationType).toBe('funky:outbox:weekly_progress_digest');
      expect(outbox.value?.metadata).toEqual(
        expect.objectContaining({
          digestType: 'weekly_progress_digest',
          campaignKey: 'funky',
          userId: baseInput.userId,
          weekKey: baseInput.weekKey,
        })
      );
    }
  });

  it('returns dry_run without creating an outbox row', async () => {
    const notification = createTestNotification({
      id: 'notif-global-1',
      userId: 'user-1',
      entityCui: null,
      notificationType: 'funky:notification:global',
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueueWeeklyProgressDigestNotification(
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
      buildWeeklyProgressDigestDeliveryKey({
        userId: baseInput.userId,
        weekKey: baseInput.weekKey,
      })
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value).toBeNull();
    }
  });

  it('skips when no eligible campaign-global preference exists', async () => {
    const result = await enqueueWeeklyProgressDigestNotification(
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

  it('skips a delivered existing occurrence instead of resending it', async () => {
    const notification = createTestNotification({
      id: 'notif-global-1',
      userId: 'user-1',
      entityCui: null,
      notificationType: 'funky:notification:global',
    });
    const deliveryKey = buildWeeklyProgressDigestDeliveryKey({
      userId: baseInput.userId,
      weekKey: baseInput.weekKey,
    });
    const existingOutbox = createTestDeliveryRecord({
      id: 'outbox-1',
      userId: 'user-1',
      notificationType: 'funky:outbox:weekly_progress_digest',
      referenceId: notification.id,
      scopeKey: 'digest:weekly_progress:funky:2026-W16',
      deliveryKey,
      status: 'delivered',
      metadata: {
        digestType: 'weekly_progress_digest',
        campaignKey: 'funky',
        userId: 'user-1',
        weekKey: '2026-W16',
        periodLabel: baseInput.periodLabel,
        watermarkAt: baseInput.watermarkAt,
        summary: baseInput.summary,
        items: baseInput.items,
        primaryCta: baseInput.primaryCta,
        secondaryCtas: baseInput.secondaryCtas,
        allUpdatesUrl: baseInput.allUpdatesUrl,
      },
    });

    const result = await enqueueWeeklyProgressDigestNotification(
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

  it('replays a skipped weekly digest when the user becomes eligible later in the same week', async () => {
    const notification = createTestNotification({
      id: 'notif-global-1',
      userId: 'user-1',
      entityCui: null,
      notificationType: 'funky:notification:global',
      isActive: true,
    });
    const deliveryKey = buildWeeklyProgressDigestDeliveryKey({
      userId: baseInput.userId,
      weekKey: baseInput.weekKey,
    });
    const existingOutbox = createTestDeliveryRecord({
      id: 'outbox-replay',
      userId: 'user-1',
      notificationType: 'funky:outbox:weekly_progress_digest',
      referenceId: notification.id,
      scopeKey: 'digest:weekly_progress:funky:2026-W16',
      deliveryKey,
      status: 'skipped_unsubscribed',
      renderedSubject: 'Digest',
      renderedHtml: '<p>Hello</p>',
      renderedText: 'Hello',
      metadata: {
        digestType: 'weekly_progress_digest',
        campaignKey: 'funky',
        userId: 'user-1',
        weekKey: '2026-W16',
        periodLabel: baseInput.periodLabel,
        watermarkAt: baseInput.watermarkAt,
        summary: baseInput.summary,
        items: baseInput.items,
        primaryCta: baseInput.primaryCta,
        secondaryCtas: baseInput.secondaryCtas,
        allUpdatesUrl: baseInput.allUpdatesUrl,
      },
    });

    const result = await enqueueWeeklyProgressDigestNotification(
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
      expect(result.value.status).toBe('queued');
      expect(result.value.reason).toBe('existing_failed_transient');
      expect(result.value.outboxId).toBe(existingOutbox.id);
      expect(result.value.source).toBe('reused');
      expect(result.value.outboxStatus).toBe('pending');
    }
  });
});
