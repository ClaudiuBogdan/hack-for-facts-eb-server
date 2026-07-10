import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES } from '@/infra/queue/client.js';
import { assignToDigest } from '@/modules/notification-platform/core/digest/usecases/assign-to-digest.js';

import { makeFlowHarness } from './harness.js';
import { makeLogicalNotification } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('notification platform digest flow', () => {
  it('materializes an immutable daily batch and sends content for both members', async () => {
    const h = makeFlowHarness();
    const first = makeLogicalNotification(h, {
      id: 'logical-digest-1',
      inboxTitle: 'First digest item',
      inboxBody: 'First summary',
    });
    h.clock.advance(1_000);
    const second = makeLogicalNotification(h, {
      id: 'logical-digest-2',
      inboxTitle: 'Second digest item',
      inboxBody: 'Second summary',
    });
    h.logicalNotifications.store.seed([first, second]);

    const firstAssignment = expectOk(
      await assignToDigest(h, {
        logicalNotificationId: first.id,
        userId: first.userId,
        channel: 'email',
        cadence: 'daily',
      })
    );
    const secondAssignment = expectOk(
      await assignToDigest(h, {
        logicalNotificationId: second.id,
        userId: second.userId,
        channel: 'email',
        cadence: 'daily',
      })
    );
    expect(secondAssignment.batchId).toBe(firstAssignment.batchId);

    const openBatch = h.digests.store.get(firstAssignment.batchId);
    expect(openBatch).toBeDefined();
    h.clock.set(new Date((openBatch?.dispatchAtUtc.getTime() ?? 0) + 1));
    const enqueueDigest = h.runtime.enqueuer<{ limit: number }>(QUEUE_NAMES.NP_DIGEST);
    expectOk(await enqueueDigest({ limit: 10 }));
    await h.runtime.runAll();

    const batch = h.digests.store.get(firstAssignment.batchId);
    const delivery = h.deliveries.store.list()[0];
    expect(batch).toMatchObject({
      status: 'rendered',
      renderedItemIds: ['logical-digest-2', 'logical-digest-1'],
      overflowCount: 0,
    });
    expect(delivery).toMatchObject({
      deliveryKey: `digest:${firstAssignment.batchId}`,
      digestBatchId: firstAssignment.batchId,
      status: 'accepted',
    });
    expect(delivery?.renderedHtml).toContain('First digest item');
    expect(delivery?.renderedHtml).toContain('Second digest item');

    expect(
      expectOk(
        await h.digests.addMemberIdempotent({
          batchId: firstAssignment.batchId,
          logicalNotificationId: 'late-logical',
          now: h.clock.now(),
        })
      )
    ).toBe('batch_closed');
    expect(h.digests.store.get(firstAssignment.batchId)?.renderedItemIds).toEqual([
      'logical-digest-2',
      'logical-digest-1',
    ]);
  });
});
