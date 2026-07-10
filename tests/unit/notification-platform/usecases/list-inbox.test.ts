import { describe, expect, it } from 'vitest';

import { listInbox } from '@/modules/notification-platform/core/inbox/usecases/list-inbox.js';

import { makeUsecaseHarness } from './harness.js';
import { makeLogicalNotification } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('listInbox', () => {
  it('returns only the requested user view', async () => {
    const h = makeUsecaseHarness();
    h.logicalNotifications.store.seed([
      makeLogicalNotification(h, { id: 'logical-1', userId: 'user-1' }),
      makeLogicalNotification(h, { id: 'logical-2', userId: 'user-2' }),
    ]);
    const result = expectOk(await listInbox(h, { userId: 'user-1', view: 'unread' }));
    expect(result.items.map((item) => item.id)).toEqual(['logical-1']);
  });
});
