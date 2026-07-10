import { describe, expect, it } from 'vitest';

import { setArchivedState } from '@/modules/notification-platform/core/inbox/usecases/set-archived-state.js';

import { makeUsecaseHarness } from './harness.js';
import { makeLogicalNotification } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('setArchivedState', () => {
  it('archives and unarchives an owned item', async () => {
    const h = makeUsecaseHarness();
    h.logicalNotifications.store.put(makeLogicalNotification(h, { id: 'logical-1' }));
    expect(
      expectOk(
        await setArchivedState(h, {
          userId: 'user-1',
          notificationId: 'logical-1',
          archived: true,
        })
      ).updated
    ).toBe(true);
    expect(h.logicalNotifications.store.get('logical-1')?.archivedAt).not.toBeNull();
  });
});
