import { describe, expect, it } from 'vitest';

import { renderDelivery } from '@/modules/notification-platform/core/delivery/usecases/render-delivery.js';

import { makeUsecaseHarness } from './harness.js';
import {
  makeDelivery,
  makeDigestBatch,
  makeLogicalNotification,
  makeNotificationEvent,
} from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('renderDelivery', () => {
  it('renders a claimed logical delivery and enqueues active sending', async () => {
    const h = makeUsecaseHarness();
    h.events.store.put(
      makeNotificationEvent(h, {
        id: 'event-1',
        eventType: h.kind.eventType,
        facts: { subjectId: 'subject-1', title: 'Rendered title' },
      })
    );
    h.logicalNotifications.store.put(
      makeLogicalNotification(h, { id: 'logical-1', eventId: 'event-1' })
    );
    h.deliveries.store.put(
      makeDelivery(h, {
        id: 'delivery-1',
        logicalNotificationId: 'logical-1',
        status: 'pending_render',
        renderedSubject: null,
        renderedHtml: null,
        renderedText: null,
        contentHash: null,
      })
    );

    expect(expectOk(await renderDelivery(h, { deliveryId: 'delivery-1' })).rendered).toBe(true);
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('ready');
    expect(h.deliveries.store.get('delivery-1')?.renderedSubject).toBe('Rendered title');
    expect(h.runtime.pending().some((job) => job.name === 'np-delivery-send')).toBe(true);
  });

  it('renders a digest from the persisted snapshot order', async () => {
    const h = makeUsecaseHarness();
    h.logicalNotifications.store.seed([
      makeLogicalNotification(h, { id: 'logical-1', inboxTitle: 'First snapshotted' }),
      makeLogicalNotification(h, { id: 'logical-2', inboxTitle: 'Second snapshotted' }),
    ]);
    h.digests.store.put(
      makeDigestBatch(h, {
        id: 'batch-1',
        status: 'open',
      })
    );
    expectOk(
      await h.digests.addMemberIdempotent({
        batchId: 'batch-1',
        logicalNotificationId: 'logical-1',
        now: h.clock.now(),
      })
    );
    expectOk(
      await h.digests.addMemberIdempotent({
        batchId: 'batch-1',
        logicalNotificationId: 'logical-2',
        now: h.clock.now(),
      })
    );
    h.digests.store.update('batch-1', (batch) => ({
      ...batch,
      status: 'rendered',
      renderedItemIds: ['logical-1', 'logical-2'],
      overflowCount: 3,
      deliveryId: 'delivery-1',
    }));
    h.deliveries.store.put(
      makeDelivery(h, {
        id: 'delivery-1',
        logicalNotificationId: null,
        digestBatchId: 'batch-1',
        status: 'pending_render',
        renderedSubject: null,
        renderedHtml: null,
        renderedText: null,
        contentHash: null,
      })
    );

    expect(expectOk(await renderDelivery(h, { deliveryId: 'delivery-1' })).rendered).toBe(true);
    expect(h.adapter.calls.renderedDigestItemIds).toEqual([['logical-1', 'logical-2']]);
    expect(h.deliveries.store.get('delivery-1')).toMatchObject({
      status: 'ready',
      renderedSubject: 'Digest with 2 items',
      contentHash: 'digest-hash-delivery-1',
    });
  });
});
