import { describe, expect, it } from 'vitest';

import { getUnreadCount } from '@/modules/notification-platform/core/inbox/usecases/get-unread-count.js';

import { makeUsecaseHarness } from './harness.js';
import { makeLogicalNotification } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('getUnreadCount', () => {
  it('counts visible unarchived unread notifications', async () => {
    const h = makeUsecaseHarness();
    h.logicalNotifications.store.seed([
      makeLogicalNotification(h, { id: 'logical-1' }),
      makeLogicalNotification(h, { id: 'logical-2', archivedAt: h.clock.now() }),
    ]);
    expect(expectOk(await getUnreadCount(h, { userId: 'user-1' })).count).toBe(1);
  });
});
