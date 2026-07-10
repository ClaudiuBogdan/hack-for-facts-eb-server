import { describe, expect, it } from 'vitest';

import { setReadState } from '@/modules/notification-platform/core/inbox/usecases/set-read-state.js';

import { makeUsecaseHarness } from './harness.js';
import { makeLogicalNotification } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('setReadState', () => {
  it('enforces ownership through the repository predicate', async () => {
    const h = makeUsecaseHarness();
    h.logicalNotifications.store.put(makeLogicalNotification(h, { id: 'logical-1' }));
    expect(
      expectOk(
        await setReadState(h, { userId: 'other-user', notificationId: 'logical-1', read: true })
      ).updated
    ).toBe(false);
    expect(
      expectOk(await setReadState(h, { userId: 'user-1', notificationId: 'logical-1', read: true }))
        .updated
    ).toBe(true);
    expect(h.logicalNotifications.store.get('logical-1')?.readAt).toEqual(h.clock.now());
  });
});
