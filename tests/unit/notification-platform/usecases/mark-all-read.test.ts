import { describe, expect, it } from 'vitest';

import { markAllRead } from '@/modules/notification-platform/core/inbox/usecases/mark-all-read.js';

import { makeUsecaseHarness } from './harness.js';
import { makeLogicalNotification } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('markAllRead', () => {
  it('marks all current unread items', async () => {
    const h = makeUsecaseHarness();
    h.logicalNotifications.store.seed([
      makeLogicalNotification(h, { id: 'logical-1' }),
      makeLogicalNotification(h, { id: 'logical-2' }),
    ]);
    expect(expectOk(await markAllRead(h, { userId: 'user-1' })).updated).toBe(2);
    expect(h.logicalNotifications.store.list().every((item) => item.readAt !== null)).toBe(true);
  });
});
