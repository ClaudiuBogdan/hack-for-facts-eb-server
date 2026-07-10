import { describe, expect, it } from 'vitest';

import { requeueDeadLetter } from '@/modules/notification-platform/core/delivery/usecases/requeue-dead-letter.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDelivery } from '../../../fixtures/notification-platform/index.js';
import { expectErr, expectOk } from '../../../support/index.js';

describe('requeueDeadLetter', () => {
  it('requires duplicate-risk acknowledgement for unknown deliveries', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1', status: 'unknown' }));
    const input = {
      deliveryId: 'delivery-1',
      adminUserId: 'admin-1',
      reason: 'manual retry',
      acknowledgeDuplicateRisk: false,
    };
    expect(expectErr(await requeueDeadLetter(h, input)).type).toBe('Forbidden');
    expect(
      expectOk(await requeueDeadLetter(h, { ...input, acknowledgeDuplicateRisk: true })).requeued
    ).toBe(true);
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('ready');
    expect(h.audit.store.list().map((entry) => entry.action)).toEqual([
      'admin.ambiguous_acknowledged',
      'admin.requeued',
    ]);
  });

  it('requeues permanent_failed without duplicate-risk acknowledgement', async () => {
    const h = makeUsecaseHarness();
    h.deliveries.store.put(makeDelivery(h, { id: 'delivery-1', status: 'permanent_failed' }));
    expect(
      expectOk(
        await requeueDeadLetter(h, {
          deliveryId: 'delivery-1',
          adminUserId: 'admin-1',
          reason: 'provider configuration fixed',
          acknowledgeDuplicateRisk: false,
        })
      ).requeued
    ).toBe(true);
    expect(h.deliveries.store.get('delivery-1')?.status).toBe('ready');
    expect(h.audit.store.list().map((entry) => entry.action)).toEqual(['admin.requeued']);
  });
});
