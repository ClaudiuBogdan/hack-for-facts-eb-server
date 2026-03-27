import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeResendWebhookDeliverySideEffect } from '@/modules/notification-delivery/index.js';

import {
  createTestDeliveryRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
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

  it('handles transient and permanent bounces differently', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [createTestNotification({ id: 'notification-1', isActive: true })],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'delivery-transient',
          notificationId: 'notification-1',
          status: 'sent',
        }),
        createTestDeliveryRecord({
          id: 'delivery-permanent',
          notificationId: 'notification-1',
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
        createTestDeliveryRecord({ id: 'delivery-1', notificationId: 'notification-1' }),
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
        createTestDeliveryRecord({ id: 'delivery-1', notificationId: 'notification-1' }),
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
});
