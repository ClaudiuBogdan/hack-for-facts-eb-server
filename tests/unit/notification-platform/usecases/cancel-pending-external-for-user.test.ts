import { describe, expect, it } from 'vitest';

import { cancelPendingExternalForUser } from '@/modules/notification-platform/core/delivery/usecases/cancel-pending-external-for-user.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('cancelPendingExternalForUser', () => {
  it('cancels only matching pending external work', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.seed([
      makeDelivery(h, { id: 'delivery-1', userId: 'user-1' }),
      makeDelivery(h, { id: 'delivery-2', userId: 'user-2' }),
    ]);
    const result = expectOk(
      await cancelPendingExternalForUser(h, { userId: 'user-1', reason: 'preference_off' })
    );
    expect(result.cancelled).toBe(1);
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('cancelled');
    expect(h.deliveries.store.get('delivery-2')?.status).toBe('ready');
  });
});
