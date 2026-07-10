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
});
