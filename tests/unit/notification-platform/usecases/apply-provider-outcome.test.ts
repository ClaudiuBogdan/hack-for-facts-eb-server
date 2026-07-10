import { describe, expect, it } from 'vitest';

import { applyProviderOutcome } from '@/modules/notification-platform/core/delivery/usecases/apply-provider-outcome.js';

import { makeUsecaseHarness } from './harness.js';
import {
  makeChannelDestination,
  makeDelivery,
} from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('applyProviderOutcome', () => {
  it('applies monotonic bounce once and suppresses only the fingerprint', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, { id: 'delivery-1', status: 'accepted', providerRef: 'provider-1' })
    );
    h.destinations.store.put(makeChannelDestination(h));
    const input = {
      providerRef: 'provider-1',
      outcome: 'bounced' as const,
      occurredAt: h.clock.now(),
      destinationFingerprint: 'fingerprint-1',
    };
    expect(expectOk(await applyProviderOutcome(h, input)).applied).toBe(true);
    expect(expectOk(await applyProviderOutcome(h, input)).applied).toBe(false);
    expect(h.destinations.store.list()[0]?.suppressedAt).not.toBeNull();
    expect(h.audit.store.list().some((entry) => entry.action === 'destination.suppressed')).toBe(
      true
    );
  });

  it('falls back to the delivery id and persists the webhook provider reference', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, { id: 'delivery-tagged', status: 'accepted', providerRef: null })
    );

    const result = expectOk(
      await applyProviderOutcome(h, {
        providerRef: 'provider-from-webhook',
        deliveryId: 'delivery-tagged',
        outcome: 'delivered',
        occurredAt: h.clock.now(),
      })
    );

    expect(result.applied).toBe(true);
    expect(h.deliveries.store.get('delivery-tagged')).toMatchObject({
      status: 'delivered',
      providerRef: 'provider-from-webhook',
    });
  });

  it('prefers a provider reference match over a supplied delivery id', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.seed([
      makeDelivery(h, { id: 'provider-match', status: 'accepted', providerRef: 'provider-1' }),
      makeDelivery(h, { id: 'tag-match', status: 'accepted', providerRef: null }),
    ]);

    expect(
      expectOk(
        await applyProviderOutcome(h, {
          providerRef: 'provider-1',
          deliveryId: 'tag-match',
          outcome: 'delivered',
          occurredAt: h.clock.now(),
        })
      ).applied
    ).toBe(true);
    expect(h.deliveries.store.get('provider-match')?.status).toBe('delivered');
    expect(h.deliveries.store.get('tag-match')?.status).toBe('accepted');
  });

  it('persists a provider reference from a delayed event without changing state', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, { id: 'delivery-delayed', status: 'sending', providerRef: null })
    );

    const result = expectOk(
      await applyProviderOutcome(h, {
        providerRef: 'provider-delayed',
        deliveryId: 'delivery-delayed',
        outcome: 'delayed',
        occurredAt: h.clock.now(),
      })
    );

    expect(result.applied).toBe(false);
    expect(h.deliveries.store.get('delivery-delayed')).toMatchObject({
      status: 'sending',
      providerRef: 'provider-delayed',
    });
  });
});
