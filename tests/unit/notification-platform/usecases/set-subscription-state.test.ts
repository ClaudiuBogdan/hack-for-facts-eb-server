import { describe, expect, it } from 'vitest';

import { setSubscriptionState } from '@/modules/notification-platform/core/subscriptions/usecases/set-subscription-state.js';

import { makeUsecaseHarness } from './harness.js';
import { makeSubscription } from '../../../fixtures/notification-platform/index.js';
import { expectErr, expectOk } from '../../../support/index.js';

describe('setSubscriptionState', () => {
  it('updates only an owned subscription', async () => {
    const h = makeUsecaseHarness();
    h.subscriptions.store.put(makeSubscription(h, { id: 'subscription-1' }));
    expect(
      expectOk(
        await setSubscriptionState(h, {
          userId: 'user-1',
          subscriptionId: 'subscription-1',
          state: 'paused',
        })
      ).state
    ).toBe('paused');
    expect(
      expectErr(
        await setSubscriptionState(h, {
          userId: 'other-user',
          subscriptionId: 'subscription-1',
          state: 'active',
        })
      ).type
    ).toBe('NotFound');
  });
});
