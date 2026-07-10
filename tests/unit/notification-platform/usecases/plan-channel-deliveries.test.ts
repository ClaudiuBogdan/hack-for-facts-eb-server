import { describe, expect, it } from 'vitest';

import { planChannelDeliveries } from '@/modules/notification-platform/core/delivery/usecases/plan-channel-deliveries.js';

import { makeUsecaseHarness } from './harness.js';
import { makeLogicalNotification } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('planChannelDeliveries', () => {
  it('creates immediate delivery once and assigns digest membership idempotently', async () => {
    const h = makeUsecaseHarness();
    const immediateLogical = makeLogicalNotification(h, { id: 'logical-immediate' });
    const first = expectOk(
      await planChannelDeliveries(h, {
        logical: immediateLogical,
        kind: h.kind,
        channelPlan: [{ channel: 'email', cadence: 'immediate' }],
      })
    );
    const replay = expectOk(
      await planChannelDeliveries(h, {
        logical: immediateLogical,
        kind: h.kind,
        channelPlan: [{ channel: 'email', cadence: 'immediate' }],
      })
    );
    expect(first.immediate).toBe(1);
    expect(replay.immediate).toBe(0);
    expect(h.deliveries.store.size()).toBe(1);

    const digestLogical = makeLogicalNotification(h, { id: 'logical-digest' });
    const digest = expectOk(
      await planChannelDeliveries(h, {
        logical: digestLogical,
        kind: h.kind,
        channelPlan: [{ channel: 'email', cadence: 'daily' }],
      })
    );
    expect(digest.digested).toBe(1);
    expect(h.digests.members.size()).toBe(1);
    expect(h.audit.store.list().some((entry) => entry.action === 'delivery.created')).toBe(true);
  });
});
