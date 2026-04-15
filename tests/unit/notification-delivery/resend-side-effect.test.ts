import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { getWeeklyDigestCursor } from '@/modules/learning-progress/index.js';
import {
  buildAnafForexebugDigestScopeKey,
  createWeeklyProgressDigestPostSendReconciler,
  makeResendWebhookDeliverySideEffect,
} from '@/modules/notification-delivery/index.js';

import {
  createTestDeliveryRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeLearningProgressRepo,
  makeFakeNotificationsRepo,
} from '../../fixtures/fakes.js';

import type { ResendEmailWebhookEvent } from '@/modules/resend-webhooks/index.js';

const testLogger = pinoLogger({ level: 'silent' });

const createEvent = (
  type: ResendEmailWebhookEvent['type'],
  tags?: { name: string; value: string }[],
  overrides: Partial<ResendEmailWebhookEvent['data']> = {}
): ResendEmailWebhookEvent => ({
  type,
  created_at: '2026-03-23T10:00:00.000Z',
  data: {
    email_id: 'email-1',
    from: 'noreply@transparenta.eu',
    to: ['user@example.com'],
    subject: 'Subject',
    created_at: '2026-03-23T09:59:00.000Z',
    ...(tags !== undefined ? { tags } : {}),
    ...overrides,
  },
});

describe('makeResendWebhookDeliverySideEffect', () => {
  it('reconciles email.sent into sent for a sending delivery', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [createTestDeliveryRecord({ id: 'delivery-1', status: 'sending' })],
    });
    const notificationsRepo = makeFakeNotificationsRepo();
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.sent', [{ name: 'delivery_id', value: 'delivery-1' }]),
      storedEvent: {
        id: 'stored-1',
        svixId: 'svix-1',
        eventType: 'email.sent',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('delivery-1');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('sent');
      expect(delivery.value?.resendEmailId).toBe('email-1');
    }
  });

  it('marks delivered deliveries as delivered', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [createTestDeliveryRecord({ id: 'delivery-1', status: 'sent' })],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo: makeFakeNotificationsRepo(),
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.delivered', [{ name: 'delivery_id', value: 'delivery-1' }]),
      storedEvent: {
        id: 'stored-1',
        svixId: 'svix-1',
        eventType: 'email.delivered',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('delivery-1');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('delivered');
    }
  });

  it('repairs the weekly digest cursor from a delivered webhook', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'digest-delivery-1',
          userId: 'user-1',
          notificationType: 'funky:outbox:weekly_progress_digest',
          referenceId: 'notif-global-1',
          scopeKey: 'digest:weekly_progress:funky:2026-W16',
          deliveryKey: 'digest:weekly_progress:funky:user-1:2026-W16',
          status: 'sent',
          sentAt: new Date('2026-04-15T09:05:00.000Z'),
          metadata: {
            digestType: 'weekly_progress_digest',
            campaignKey: 'funky',
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
                statusTone: 'danger',
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
            secondaryCtas: [],
            allUpdatesUrl: null,
          },
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo: makeFakeNotificationsRepo(),
      logger: testLogger,
      weeklyProgressDigestPostSendReconciler: createWeeklyProgressDigestPostSendReconciler({
        learningProgressRepo,
        logger: testLogger,
      }),
    });

    await sideEffect.handle({
      event: createEvent('email.delivered', [{ name: 'delivery_id', value: 'digest-delivery-1' }]),
      storedEvent: {
        id: 'stored-digest-delivered',
        svixId: 'svix-digest-delivered',
        eventType: 'email.delivered',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date('2026-04-15T09:06:00.000Z'),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const cursor = await getWeeklyDigestCursor(
      { repo: learningProgressRepo },
      { userId: 'user-1' }
    );
    expect(cursor.isOk()).toBe(true);
    if (cursor.isOk()) {
      expect(cursor.value).toEqual({
        campaignKey: 'funky',
        lastSentAt: '2026-04-15T09:06:00.000Z',
        watermarkAt: '2026-04-15T09:00:00.000Z',
        weekKey: '2026-W16',
        outboxId: 'digest-delivery-1',
      });
    }
  });

  it('backfills sentAt and repairs the cursor when delivered arrives before sent', async () => {
    const learningProgressRepo = makeFakeLearningProgressRepo();
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'digest-delivery-out-of-order',
          userId: 'user-1',
          notificationType: 'funky:outbox:weekly_progress_digest',
          referenceId: 'notif-global-1',
          scopeKey: 'digest:weekly_progress:funky:2026-W16',
          deliveryKey: 'digest:weekly_progress:funky:user-1:2026-W16',
          status: 'sending',
          sentAt: null,
          metadata: {
            digestType: 'weekly_progress_digest',
            campaignKey: 'funky',
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
                statusTone: 'danger',
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
            secondaryCtas: [],
            allUpdatesUrl: null,
          },
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo: makeFakeNotificationsRepo(),
      logger: testLogger,
      weeklyProgressDigestPostSendReconciler: createWeeklyProgressDigestPostSendReconciler({
        learningProgressRepo,
        logger: testLogger,
      }),
    });
    const emailCreatedAt = new Date('2026-04-15T09:06:00.000Z');

    await sideEffect.handle({
      event: createEvent('email.delivered', [
        { name: 'delivery_id', value: 'digest-delivery-out-of-order' },
      ]),
      storedEvent: {
        id: 'stored-digest-out-of-order-delivered',
        svixId: 'svix-digest-out-of-order-delivered',
        eventType: 'email.delivered',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt,
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    await sideEffect.handle({
      event: createEvent('email.sent', [
        { name: 'delivery_id', value: 'digest-delivery-out-of-order' },
      ]),
      storedEvent: {
        id: 'stored-digest-out-of-order-sent',
        svixId: 'svix-digest-out-of-order-sent',
        eventType: 'email.sent',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt,
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('digest-delivery-out-of-order');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('delivered');
      expect(delivery.value?.sentAt?.toISOString()).toBe('2026-04-15T09:06:00.000Z');
    }

    const cursor = await getWeeklyDigestCursor(
      { repo: learningProgressRepo },
      { userId: 'user-1' }
    );
    expect(cursor.isOk()).toBe(true);
    if (cursor.isOk()) {
      expect(cursor.value).toEqual({
        campaignKey: 'funky',
        lastSentAt: '2026-04-15T09:06:00.000Z',
        watermarkAt: '2026-04-15T09:00:00.000Z',
        weekKey: '2026-W16',
        outboxId: 'digest-delivery-out-of-order',
      });
    }
  });

  it('reconciles transactional welcome emails without a notification_id tag', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'welcome-1',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-1',
          status: 'sent',
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo: makeFakeNotificationsRepo(),
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.delivered', [{ name: 'delivery_id', value: 'welcome-1' }]),
      storedEvent: {
        id: 'stored-welcome-1',
        svixId: 'svix-welcome-1',
        eventType: 'email.delivered',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('welcome-1');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('delivered');
      expect(delivery.value?.referenceId).toBeNull();
    }
  });

  it('deactivates bundled source notifications using outbox metadata when notification_id tag is missing', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [
        createTestNotification({ id: 'notification-1', isActive: true }),
        createTestNotification({
          id: 'notification-2',
          notificationType: 'alert_series_analytics',
          isActive: true,
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'bundle-delivery-1',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: buildAnafForexebugDigestScopeKey('2026-03'),
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          status: 'sent',
          metadata: {
            sourceNotificationIds: ['notification-1', 'notification-2'],
          },
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent(
        'email.suppressed',
        [{ name: 'delivery_id', value: 'bundle-delivery-1' }],
        {
          reason: 'complaint',
        }
      ),
      storedEvent: {
        id: 'stored-bundle-1',
        svixId: 'svix-bundle-1',
        eventType: 'email.suppressed',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const notification1 = await notificationsRepo.findById('notification-1');
    const notification2 = await notificationsRepo.findById('notification-2');

    expect(notification1.isOk()).toBe(true);
    expect(notification2.isOk()).toBe(true);

    if (notification1.isOk()) {
      expect(notification1.value?.isActive).toBe(false);
    }

    if (notification2.isOk()) {
      expect(notification2.value?.isActive).toBe(false);
    }
  });

  it('handles transient and permanent bounces differently', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [createTestNotification({ id: 'notification-1', isActive: true })],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'delivery-transient',
          referenceId: 'notification-1',
          status: 'sent',
        }),
        createTestDeliveryRecord({
          id: 'delivery-permanent',
          referenceId: 'notification-1',
          status: 'sent',
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent(
        'email.bounced',
        [
          { name: 'delivery_id', value: 'delivery-transient' },
          { name: 'notification_id', value: 'notification-1' },
        ],
        {
          bounce: {
            type: 'Transient',
            subType: 'MailboxFull',
          },
        }
      ),
      storedEvent: {
        id: 'stored-1',
        svixId: 'svix-1',
        eventType: 'email.bounced',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: 'Transient',
        bounceSubType: 'MailboxFull',
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    let delivery = await deliveryRepo.findById('delivery-transient');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('failed_transient');
    }

    await sideEffect.handle({
      event: createEvent(
        'email.bounced',
        [
          { name: 'delivery_id', value: 'delivery-permanent' },
          { name: 'notification_id', value: 'notification-1' },
        ],
        {
          bounce: {
            type: 'Permanent',
            subType: 'General',
          },
        }
      ),
      storedEvent: {
        id: 'stored-2',
        svixId: 'svix-2',
        eventType: 'email.bounced',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-2',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    delivery = await deliveryRepo.findById('delivery-permanent');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('suppressed');
    }

    const notification = await notificationsRepo.findById('notification-1');
    expect(notification.isOk()).toBe(true);
    if (notification.isOk()) {
      expect(notification.value?.isActive).toBe(false);
    }
  });

  it('deactivates notifications for complaints and suppressions', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [createTestNotification({ id: 'notification-1', isActive: true })],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'delivery-1',
          referenceId: 'notification-1',
          status: 'sent',
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.complained', [
        { name: 'delivery_id', value: 'delivery-1' },
        { name: 'notification_id', value: 'notification-1' },
      ]),
      storedEvent: {
        id: 'stored-1',
        svixId: 'svix-1',
        eventType: 'email.complained',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('delivery-1');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('suppressed');
    }

    const notification = await notificationsRepo.findById('notification-1');
    expect(notification.isOk()).toBe(true);
    if (notification.isOk()) {
      expect(notification.value?.isActive).toBe(false);
    }
  });

  it('still deactivates notifications for permanent bounces when delivery updates fail', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [createTestNotification({ id: 'notification-1', isActive: true })],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo: makeFakeDeliveryRepo({ simulateDbError: true }),
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent(
        'email.bounced',
        [
          { name: 'delivery_id', value: 'delivery-1' },
          { name: 'notification_id', value: 'notification-1' },
        ],
        {
          bounce: {
            type: 'Permanent',
            subType: 'General',
          },
        }
      ),
      storedEvent: {
        id: 'stored-1',
        svixId: 'svix-1',
        eventType: 'email.bounced',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const notification = await notificationsRepo.findById('notification-1');
    expect(notification.isOk()).toBe(true);
    if (notification.isOk()) {
      expect(notification.value?.isActive).toBe(false);
    }
  });

  it('still deactivates notifications for complaints when delivery updates fail', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [createTestNotification({ id: 'notification-1', isActive: true })],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo: makeFakeDeliveryRepo({ simulateDbError: true }),
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.complained', [
        { name: 'delivery_id', value: 'delivery-1' },
        { name: 'notification_id', value: 'notification-1' },
      ]),
      storedEvent: {
        id: 'stored-1',
        svixId: 'svix-1',
        eventType: 'email.complained',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const notification = await notificationsRepo.findById('notification-1');
    expect(notification.isOk()).toBe(true);
    if (notification.isOk()) {
      expect(notification.value?.isActive).toBe(false);
    }
  });

  it('skips safely when delivery_id or notification_id tags are missing', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [createTestNotification({ id: 'notification-1', isActive: true })],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'delivery-1',
          referenceId: 'notification-1',
          status: 'sent',
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.delivered'),
      storedEvent: {
        id: 'stored-1',
        svixId: 'svix-1',
        eventType: 'email.delivered',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    await sideEffect.handle({
      event: createEvent('email.complained', [{ name: 'delivery_id', value: 'delivery-1' }]),
      storedEvent: {
        id: 'stored-2',
        svixId: 'svix-2',
        eventType: 'email.complained',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-2',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('delivery-1');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('suppressed');
    }

    const notification = await notificationsRepo.findById('notification-1');
    expect(notification.isOk()).toBe(true);
    if (notification.isOk()) {
      expect(notification.value?.isActive).toBe(true);
    }
  });

  it('does not let a late transient bounce regress a delivered row', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [createTestDeliveryRecord({ id: 'delivery-ordered', status: 'sent' })],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo: makeFakeNotificationsRepo(),
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.delivered', [{ name: 'delivery_id', value: 'delivery-ordered' }]),
      storedEvent: {
        id: 'stored-delivered',
        svixId: 'svix-delivered',
        eventType: 'email.delivered',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    await sideEffect.handle({
      event: createEvent('email.bounced', [{ name: 'delivery_id', value: 'delivery-ordered' }], {
        bounce: { type: 'Transient', subType: 'MailboxFull' },
      }),
      storedEvent: {
        id: 'stored-bounce',
        svixId: 'svix-bounce',
        eventType: 'email.bounced',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: 'Transient',
        bounceSubType: 'MailboxFull',
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('delivery-ordered');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('delivered');
    }
  });

  it('lets a complaint override delivered status to suppressed', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [createTestNotification({ id: 'notification-complaint', isActive: true })],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'delivery-complaint',
          referenceId: 'notification-complaint',
          status: 'sent',
        }),
      ],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo,
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.delivered', [{ name: 'delivery_id', value: 'delivery-complaint' }]),
      storedEvent: {
        id: 'stored-delivered-complaint',
        svixId: 'svix-delivered-complaint',
        eventType: 'email.delivered',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    await sideEffect.handle({
      event: createEvent('email.complained', [
        { name: 'delivery_id', value: 'delivery-complaint' },
        { name: 'notification_id', value: 'notification-complaint' },
      ]),
      storedEvent: {
        id: 'stored-complaint',
        svixId: 'svix-complaint',
        eventType: 'email.complained',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('delivery-complaint');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('suppressed');
    }
  });

  it('ignores delivery_delayed without mutating state', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [createTestDeliveryRecord({ id: 'delivery-delayed', status: 'sent' })],
    });
    const sideEffect = makeResendWebhookDeliverySideEffect({
      deliveryRepo,
      notificationsRepo: makeFakeNotificationsRepo(),
      logger: testLogger,
    });

    await sideEffect.handle({
      event: createEvent('email.delivery_delayed', [
        { name: 'delivery_id', value: 'delivery-delayed' },
      ]),
      storedEvent: {
        id: 'stored-delayed',
        svixId: 'svix-delayed',
        eventType: 'email.delivery_delayed',
        webhookReceivedAt: new Date(),
        eventCreatedAt: new Date(),
        emailId: 'email-1',
        fromAddress: 'noreply@transparenta.eu',
        toAddresses: ['user@example.com'],
        subject: 'Subject',
        emailCreatedAt: new Date(),
        broadcastId: null,
        templateId: null,
        tags: null,
        bounceType: null,
        bounceSubType: null,
        bounceMessage: null,
        bounceDiagnosticCode: null,
        clickIpAddress: null,
        clickLink: null,
        clickTimestamp: null,
        clickUserAgent: null,
        threadKey: null,
        metadata: {},
      },
    });

    const delivery = await deliveryRepo.findById('delivery-delayed');
    expect(delivery.isOk()).toBe(true);
    if (delivery.isOk()) {
      expect(delivery.value?.status).toBe('sent');
    }
  });
});
