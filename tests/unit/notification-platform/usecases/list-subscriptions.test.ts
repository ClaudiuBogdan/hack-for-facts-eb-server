import { describe, expect, it } from 'vitest';

import { listSubscriptions } from '@/modules/notification-platform/core/subscriptions/usecases/list-subscriptions.js';

import { makeUsecaseHarness } from './harness.js';
import { makeSubscription } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('listSubscriptions', () => {
  it('filters by user and kind', async () => {
    const h = makeUsecaseHarness();
    h.subscriptions.store.seed([
      makeSubscription(h, { id: 'subscription-1', userId: 'user-1' }),
      makeSubscription(h, { id: 'subscription-2', userId: 'user-2' }),
    ]);
    const page = expectOk(await listSubscriptions(h, { userId: 'user-1', kindId: h.kind.kindId }));
    expect(page.items.map((item) => item.id)).toEqual(['subscription-1']);
  });
});
