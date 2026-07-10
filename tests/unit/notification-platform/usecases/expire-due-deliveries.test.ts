import { describe, expect, it } from 'vitest';

import { expireDueDeliveries } from '@/modules/notification-platform/core/delivery/usecases/expire-due-deliveries.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('expireDueDeliveries', () => {
  it('expires due unsent deliveries and audits terminal state', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, { id: 'delivery-1', expiresAt: new Date(h.clock.now().getTime() - 1) })
    );
    expect(expectOk(await expireDueDeliveries(h, { limit: 10 })).expired).toBe(1);
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('expired');
    expect(h.audit.store.list()[0]?.action).toBe('delivery.terminal');
  });
});
