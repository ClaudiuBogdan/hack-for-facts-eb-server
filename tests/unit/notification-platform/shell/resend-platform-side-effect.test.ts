import { describe, expect, it } from 'vitest';

import { computeDestinationFingerprint } from '@/modules/notification-platform/shell/channel/destination-fingerprint.js';
import { makeResendPlatformWebhookSideEffect } from '@/modules/notification-platform/shell/webhook/resend-platform-side-effect.js';

import {
  makeChannelDestination,
  makeDelivery,
  makeFakeAuditLedgerPort,
  makeFakeChannelDestinationRepo,
  makeFakeDeliveryRepo,
  makeFakeLoggerPort,
} from '../../../fixtures/notification-platform/index.js';
import { makeSequentialIds, makeTestClock } from '../../../support/index.js';

import type {
  ResendEmailEventType,
  ResendWebhookSideEffectInput,
} from '@/modules/resend-webhooks/index.js';

const makeWebhookInput = (
  eventType: ResendEmailEventType,
  emailId: string,
  address: string,
  options: { bounceType?: string; deliveryId?: string } = {}
): ResendWebhookSideEffectInput => {
  const occurredAt = new Date('2026-07-10T10:00:00.000Z');
  const tags =
    options.deliveryId === undefined
      ? undefined
      : [{ name: 'delivery_id', value: options.deliveryId }];
  return {
    event: {
      type: eventType,
      created_at: occurredAt.toISOString(),
      data: {
        email_id: emailId,
        from: 'notificari@transparenta.eu',
        to: [address],
        subject: 'Webhook test',
        created_at: occurredAt.toISOString(),
        ...(tags === undefined ? {} : { tags }),
        ...(eventType !== 'email.bounced'
          ? {}
          : {
              bounce: {
                type: options.bounceType ?? 'Permanent',
                subType: 'General',
              },
            }),
      },
    },
    storedEvent: {
      id: 'stored-1',
      svixId: 'svix-1',
      eventType,
      webhookReceivedAt: occurredAt,
      eventCreatedAt: occurredAt,
      emailId,
      fromAddress: 'notificari@transparenta.eu',
      toAddresses: [address],
      subject: 'Webhook test',
      emailCreatedAt: occurredAt,
      broadcastId: null,
      templateId: null,
      tags: tags ?? null,
      bounceType: eventType === 'email.bounced' ? (options.bounceType ?? 'Permanent') : null,
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
  };
};

describe('makeResendPlatformWebhookSideEffect', () => {
  it('normalizes bounce addresses into fingerprints and suppresses the destination', async () => {
    const clock = makeTestClock(new Date('2026-07-10T09:00:00.000Z'));
    const ids = makeSequentialIds('webhook');
    const logger = makeFakeLoggerPort();
    const deliveries = makeFakeDeliveryRepo({ clock });
    const destinations = makeFakeChannelDestinationRepo({ ids });
    const fingerprint = computeDestinationFingerprint('fingerprint-secret', 'user@example.com');
    const delivery = makeDelivery(
      { clock, ids },
      {
        id: 'delivery-1',
        status: 'accepted',
        providerRef: 'provider-email-1',
        destinationFingerprint: fingerprint,
      }
    );
    deliveries.store.put(delivery);
    destinations.store.put(
      makeChannelDestination(
        { clock, ids },
        { userId: delivery.userId, fingerprint, channel: 'email' }
      )
    );
    const sideEffect = makeResendPlatformWebhookSideEffect({
      deliveries,
      destinations,
      audit: makeFakeAuditLedgerPort({ ids }),
      clock,
      ids,
      logger,
      fingerprintSecret: 'fingerprint-secret',
    });

    await sideEffect.handle(
      makeWebhookInput('email.bounced', 'provider-email-1', '  User@Example.COM  ')
    );

    expect(deliveries.store.get(delivery.id)?.status).toBe('bounced');
    expect(
      destinations.store.list().find((destination) => destination.fingerprint === fingerprint)
        ?.suppressionReason
    ).toBe('bounced');
    expect(JSON.stringify(logger.entries)).not.toContain('User@Example.COM');
    expect(JSON.stringify(logger.entries)).not.toContain('user@example.com');
  });

  it.each([
    ['email.bounced' as const, { bounceType: 'Temporary' }],
    ['email.delivery_delayed' as const, {}],
  ])('keeps state and suppression unchanged for %s', async (eventType, options) => {
    const clock = makeTestClock(new Date('2026-07-10T09:00:00.000Z'));
    const ids = makeSequentialIds('webhook');
    const deliveries = makeFakeDeliveryRepo({ clock });
    const destinations = makeFakeChannelDestinationRepo({ ids });
    const fingerprint = computeDestinationFingerprint('fingerprint-secret', 'user@example.com');
    const delivery = makeDelivery(
      { clock, ids },
      {
        id: 'delivery-soft',
        status: 'accepted',
        providerRef: 'provider-soft',
        destinationFingerprint: fingerprint,
      }
    );
    deliveries.store.put(delivery);
    destinations.store.put(
      makeChannelDestination(
        { clock, ids },
        { userId: delivery.userId, fingerprint, channel: 'email' }
      )
    );
    const sideEffect = makeResendPlatformWebhookSideEffect({
      deliveries,
      destinations,
      audit: makeFakeAuditLedgerPort({ ids }),
      clock,
      ids,
      logger: makeFakeLoggerPort(),
      fingerprintSecret: 'fingerprint-secret',
    });

    await sideEffect.handle(
      makeWebhookInput(eventType, 'provider-soft', 'user@example.com', options)
    );

    expect(deliveries.store.get(delivery.id)?.status).toBe('accepted');
    expect(destinations.store.list()[0]?.suppressedAt).toBeNull();
  });

  it('matches an ambiguous send by its delivery_id tag and saves provider_ref', async () => {
    const clock = makeTestClock(new Date('2026-07-10T09:00:00.000Z'));
    const ids = makeSequentialIds('webhook');
    const deliveries = makeFakeDeliveryRepo({ clock });
    deliveries.store.put(
      makeDelivery({ clock, ids }, { id: 'delivery-tagged', status: 'accepted', providerRef: null })
    );
    const sideEffect = makeResendPlatformWebhookSideEffect({
      deliveries,
      destinations: makeFakeChannelDestinationRepo({ ids }),
      audit: makeFakeAuditLedgerPort({ ids }),
      clock,
      ids,
      logger: makeFakeLoggerPort(),
      fingerprintSecret: 'fingerprint-secret',
    });

    await sideEffect.handle(
      makeWebhookInput('email.delivered', 'provider-tagged', 'user@example.com', {
        deliveryId: 'delivery-tagged',
      })
    );

    expect(deliveries.store.get('delivery-tagged')).toMatchObject({
      status: 'delivered',
      providerRef: 'provider-tagged',
    });
  });

  it('ignores provider events that do not map to a platform outcome', async () => {
    const clock = makeTestClock(new Date('2026-07-10T09:00:00.000Z'));
    const ids = makeSequentialIds('webhook');
    const logger = makeFakeLoggerPort();
    const deliveries = makeFakeDeliveryRepo({ clock });
    const delivery = makeDelivery(
      { clock, ids },
      { id: 'delivery-2', status: 'accepted', providerRef: 'provider-email-2' }
    );
    deliveries.store.put(delivery);
    const sideEffect = makeResendPlatformWebhookSideEffect({
      deliveries,
      destinations: makeFakeChannelDestinationRepo({ ids }),
      audit: makeFakeAuditLedgerPort({ ids }),
      clock,
      ids,
      logger,
      fingerprintSecret: 'fingerprint-secret',
    });

    await sideEffect.handle(
      makeWebhookInput('email.opened', 'provider-email-2', 'user@example.com')
    );

    expect(deliveries.store.get(delivery.id)?.status).toBe('accepted');
    expect(logger.entries).toEqual([]);
  });
});
