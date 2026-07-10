import { describe, expect, it } from 'vitest';

import { dispatchDelivery } from '@/modules/notification-platform/core/delivery/usecases/dispatch-delivery.js';

import { makeUsecaseHarness } from './harness.js';
import {
  makeChannelDestination,
  makeDelivery,
  makeFakeChannelAdapterPort,
  makeUserNotificationPreferences,
} from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('dispatchDelivery', () => {
  it('creates the attempt before provider contact and accepts the send', async () => {
    const h = makeUsecaseHarness();
    let attemptsVisibleAtSend = 0;
    const adapter = makeFakeChannelAdapterPort({
      onSend: () => {
        attemptsVisibleAtSend = h.attempts.store.size();
      },
    });
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    h.destinations.store.put(makeChannelDestination(h));
    const result = expectOk(
      await dispatchDelivery(
        { ...h, channelAdapters: new Map([['email' as const, adapter]]) },
        {
          deliveryId: 'delivery-1',
        }
      )
    );
    expect(result.outcome).toBe('accepted');
    expect(attemptsVisibleAtSend).toBe(1);
    expect(h.attempts.store.list()[0]?.attemptNumber).toBe(1);
    expect(h.deliveries.store.get('delivery-1')?.attemptCount).toBe(1);
    expect(h.deliveries.store.get('delivery-1')?.providerRef).toBe('provider-1');
  });

  it('classifies transient failure as retry_wait with a delayed enqueue', async () => {
    const h = makeUsecaseHarness();
    const transientAdapter = makeFakeChannelAdapterPort({
      sendResultValue: {
        classification: 'transient_failure',
        errorCode: 'rate_limited',
        errorMessage: 'retry later',
        retryAfterMs: 60_000,
      },
    });
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    h.destinations.store.put(makeChannelDestination(h));
    const result = expectOk(
      await dispatchDelivery(
        { ...h, channelAdapters: new Map([['email' as const, transientAdapter]]) },
        { deliveryId: 'delivery-1' }
      )
    );
    expect(result.outcome).toBe('retry_wait');
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('retry_wait');
    expect(h.runtime.pending().some((job) => job.state === 'delayed')).toBe(true);
  });

  it('dead-letters exhausted retries', async () => {
    const h = makeUsecaseHarness();
    const adapter = makeFakeChannelAdapterPort({
      sendResultValue: {
        classification: 'transient_failure',
        errorCode: 'timeout',
        errorMessage: 'timeout',
      },
    });
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1', attemptCount: 4 }));
    h.destinations.store.put(makeChannelDestination(h));
    const result = expectOk(
      await dispatchDelivery(
        { ...h, channelAdapters: new Map([['email' as const, adapter]]) },
        { deliveryId: 'delivery-1' }
      )
    );
    expect(result.outcome).toBe('dead_letter');
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('dead_letter');
  });

  it('moves permanent failures to permanent_failed', async () => {
    const h = makeUsecaseHarness();
    const adapter = makeFakeChannelAdapterPort({
      sendResultValue: {
        classification: 'permanent_failure',
        errorCode: 'invalid',
        errorMessage: 'invalid request',
      },
    });
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    h.destinations.store.put(makeChannelDestination(h));
    expect(
      expectOk(
        await dispatchDelivery(
          { ...h, channelAdapters: new Map([['email' as const, adapter]]) },
          { deliveryId: 'delivery-1' }
        )
      ).outcome
    ).toBe('permanent_failed');
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('permanent_failed');
  });

  it('routes ambiguous outcomes through same-key retry resolution', async () => {
    const h = makeUsecaseHarness();
    const adapter = makeFakeChannelAdapterPort({
      sendResultValue: {
        classification: 'ambiguous',
        errorCode: 'socket_closed',
        errorMessage: 'unknown provider receipt',
      },
    });
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    h.destinations.store.put(makeChannelDestination(h));
    expect(
      expectOk(
        await dispatchDelivery(
          { ...h, channelAdapters: new Map([['email' as const, adapter]]) },
          { deliveryId: 'delivery-1' }
        )
      ).outcome
    ).toBe('ambiguous_retried');
    expect(h.deliveries.store.get('delivery-1')?.providerIdempotencyKey).toBe('delivery-1');
  });

  it('cancels when the destination fingerprint changed', async () => {
    const h = makeUsecaseHarness();
    const adapter = makeFakeChannelAdapterPort({ resolvedFingerprint: 'fingerprint-2' });
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    h.destinations.store.put(makeChannelDestination(h));
    expect(
      expectOk(
        await dispatchDelivery(
          { ...h, channelAdapters: new Map([['email' as const, adapter]]) },
          { deliveryId: 'delivery-1' }
        )
      ).outcome
    ).toBe('cancelled');
    expect(h.deliveries.store.get('delivery-1')?.lastErrorCode).toBe('destination_changed');
  });

  it('cancels on a late global opt-out before creating an attempt', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    h.destinations.store.put(makeChannelDestination(h));
    h.preferences.store.put(
      makeUserNotificationPreferences(h, { userId: 'user-1', globalOptionalEnabled: false })
    );
    expect(expectOk(await dispatchDelivery(h, { deliveryId: 'delivery-1' })).outcome).toBe(
      'cancelled'
    );
    expect(h.attempts.store.size()).toBe(0);
  });

  it('cancels an anonymized user before provider contact and audits the reason', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    h.destinations.store.put(makeChannelDestination(h));
    h.anonymization.anonymizedUserIds.add('user-1');

    expect(expectOk(await dispatchDelivery(h, { deliveryId: 'delivery-1' })).outcome).toBe(
      'cancelled'
    );
    expect(h.deliveries.store.get('delivery-1')?.lastErrorCode).toBe('user_anonymized');
    expect(h.attempts.store.size()).toBe(0);
    expect(h.audit.store.list()[0]?.reason).toBe('user_anonymized');
  });

  it('classifies suppression before expiry when both apply', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, { id: 'delivery-1', expiresAt: new Date(h.clock.now().getTime() - 1) })
    );
    h.destinations.store.put(
      makeChannelDestination(h, {
        suppressedAt: h.clock.now(),
        suppressionReason: 'bounce',
      })
    );

    expect(expectOk(await dispatchDelivery(h, { deliveryId: 'delivery-1' })).outcome).toBe(
      'suppressed'
    );
    expect(h.deliveries.store.get('delivery-1')?.lastErrorCode).toBe('destination_suppressed');
  });
});
