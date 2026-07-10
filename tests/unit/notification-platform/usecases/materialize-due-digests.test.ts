import { describe, expect, it } from 'vitest';

import { materializeDueDigests } from '@/modules/notification-platform/core/digest/usecases/materialize-due-digests.js';

import { makeUsecaseHarness } from './harness.js';
import {
  makeDigestBatch,
  makeLogicalNotification,
} from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('materializeDueDigests', () => {
  it('snapshots newest 20, records overflow, and makes membership immutable', async () => {
    const h = makeUsecaseHarness();
    h.digests.store.put(makeDigestBatch(h, { id: 'batch-1' }));
    for (let index = 1; index <= 21; index += 1) {
      const id = `logical-${String(index).padStart(2, '0')}`;
      h.logicalNotifications.store.put(makeLogicalNotification(h, { id }));
      expectOk(
        await h.digests.addMemberIdempotent({
          batchId: 'batch-1',
          logicalNotificationId: id,
          now: new Date(h.clock.now().getTime() + index),
        })
      );
    }

    expect(expectOk(await materializeDueDigests(h, { limit: 10 })).materialized).toBe(1);
    const batch = h.digests.store.get('batch-1');
    expect(batch?.status).toBe('rendered');
    expect(batch?.renderedItemIds).toHaveLength(20);
    expect(batch?.overflowCount).toBe(1);
    expect(h.deliveries.store.size()).toBe(1);
    expect(
      expectOk(
        await h.digests.addMemberIdempotent({
          batchId: 'batch-1',
          logicalNotificationId: 'logical-late',
          now: h.clock.now(),
        })
      )
    ).toBe('batch_closed');
  });
});
