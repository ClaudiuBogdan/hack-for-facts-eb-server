import { describe, expect, it } from 'vitest';

import { resolveAmbiguousOutcome } from '@/modules/notification-platform/core/delivery/usecases/resolve-ambiguous-outcome.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('resolveAmbiguousOutcome', () => {
  it('moves an unreconciled outcome outside the idempotency window to unknown', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, {
        id: 'delivery-1',
        status: 'sending',
        claimToken: 'claim-1',
        createdAt: new Date(h.clock.now().getTime() - 25 * 60 * 60 * 1000),
        providerIdempotencyKey: 'delivery-1',
      })
    );
    const result = expectOk(
      await resolveAmbiguousOutcome(h, {
        deliveryId: 'delivery-1',
        expectedClaimToken: 'claim-1',
      })
    );
    expect(result.resolution).toBe('unknown');
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('unknown');
    expect(h.audit.store.list()[0]?.reason).toBe('ambiguous_outcome_unknown');
  });

  it('treats a stale claim token as a fenced no-op', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, {
        id: 'delivery-1',
        status: 'sending',
        claimToken: 'new-worker-token',
      })
    );
    const result = expectOk(
      await resolveAmbiguousOutcome(h, {
        deliveryId: 'delivery-1',
        expectedClaimToken: 'stale-worker-token',
      })
    );
    expect(result.resolution).toBe('unknown');
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('sending');
    expect(h.runtime.pending()).toEqual([]);
  });
});
