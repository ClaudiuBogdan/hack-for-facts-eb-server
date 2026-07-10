import { describe, expect, it } from 'vitest';

import { cancelDigestBatch } from '@/modules/notification-platform/core/digest/usecases/cancel-digest-batch.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery, makeDigestBatch } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('cancelDigestBatch', () => {
  it('cancels the entire batch and associated delivery with an audit entry', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, {
        id: 'delivery-1',
        status: 'pending_render',
        logicalNotificationId: null,
        digestBatchId: 'batch-1',
      })
    );
    h.digests.store.put(
      makeDigestBatch(h, { id: 'batch-1', status: 'rendered', deliveryId: 'delivery-1' })
    );
    expect(
      expectOk(
        await cancelDigestBatch(h, {
          batchId: 'batch-1',
          adminUserId: 'admin-1',
          reason: 'legal redaction',
        })
      ).cancelled
    ).toBe(true);
    expect(h.digests.store.get('batch-1')?.status).toBe('cancelled');
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('cancelled');
    expect(h.audit.store.list()[0]?.action).toBe('digest.batch_cancelled');
  });

  it('leaves an already terminal linked delivery unchanged', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(
      makeDelivery(h, {
        id: 'delivery-1',
        status: 'delivered',
        logicalNotificationId: null,
        digestBatchId: 'batch-1',
      })
    );
    h.digests.store.put(
      makeDigestBatch(h, { id: 'batch-1', status: 'rendered', deliveryId: 'delivery-1' })
    );
    expectOk(
      await cancelDigestBatch(h, {
        batchId: 'batch-1',
        adminUserId: 'admin-1',
        reason: 'legal redaction',
      })
    );
    expect(h.digests.store.get('batch-1')?.status).toBe('cancelled');
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('delivered');
  });
});
