import { describe, expect, it } from 'vitest';

import { setChannelPreference } from '@/modules/notification-platform/core/preferences/usecases/set-channel-preference.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('setChannelPreference', () => {
  it('cancels that channel when switched off', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1' }));
    const preferences = expectOk(
      await setChannelPreference(h, {
        userId: 'user-1',
        channel: 'email',
        enabled: false,
        cadence: 'off',
      })
    );
    expect(preferences.channels.email).toEqual({ enabled: false, cadence: 'off' });
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('cancelled');
  });
});
