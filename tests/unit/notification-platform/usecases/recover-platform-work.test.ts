import { describe, expect, it } from 'vitest';

import { recoverPlatformWork } from '@/modules/notification-platform/core/delivery/usecases/recover-platform-work.js';

import { makeUsecaseHarness } from './harness.js';
import {
  makeDelivery,
  makeNotificationEvent,
} from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('recoverPlatformWork', () => {
  it('re-enqueues persisted event, render, and send work', async () => {
    const h = makeUsecaseHarness();
    const old = new Date(h.clock.now().getTime() - 60_000);
    h.events.store.put(makeNotificationEvent(h, { id: 'event-1', createdAt: old }));
    h.deliveries.store.seed([
      makeDelivery(h, { id: 'render-1', status: 'pending_render', createdAt: old }),
      makeDelivery(h, { id: 'send-1', status: 'ready', createdAt: old }),
    ]);

    const result = expectOk(await recoverPlatformWork(h, { thresholdMinutes: 0, limit: 10 }));
    expect(result.eventsEnqueued).toBe(1);
    expect(result.rendersEnqueued).toBe(1);
    expect(result.sendsEnqueued).toBe(1);
    expect(h.runtime.pending().map((job) => job.name)).toEqual(
      expect.arrayContaining(['np-event-fanout', 'np-delivery-render', 'np-delivery-send'])
    );
    expect(h.runtime.pending().find((job) => job.name === 'np-delivery-send')?.opts.dedupeId).toBe(
      'np-send-send-1-1'
    );
  });
});
