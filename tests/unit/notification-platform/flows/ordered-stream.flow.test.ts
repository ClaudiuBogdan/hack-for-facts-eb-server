import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES } from '@/infra/queue/client.js';
import { recordNotificationEvent } from '@/modules/notification-platform/core/events/usecases/record-notification-event.js';

import { makeFlowHarness, seedFlowRecipient } from './harness.js';
import {
  makeFakeChannelAdapterPort,
  makeTestKind,
} from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('notification platform ordered stream flow', () => {
  it('releases a successor as soon as its predecessor is accepted', async () => {
    let releaseFirst = (): void => undefined;
    let markFirstEntered = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const dispatchOrder: number[] = [];
    const adapter = makeFakeChannelAdapterPort({
      sendHandler: async ({ delivery }) => {
        const sequence = delivery.streamSequence ?? 0;
        dispatchOrder.push(sequence);
        if (sequence === 1) {
          markFirstEntered();
          await firstGate;
        }
        return ok({ classification: 'accepted', providerRef: `provider-${String(sequence)}` });
      },
    });
    const kind = makeTestKind({
      ordering: {
        streamKey: () => 'ordered-stream-1',
        streamSequence: (facts) => facts.sequence ?? 0,
      },
    });
    const h = makeFlowHarness({ adapter, kind });
    seedFlowRecipient(h);

    for (const sequence of [1, 2]) {
      expectOk(
        await recordNotificationEvent(h, {
          source: 'flow',
          eventType: kind.eventType,
          eventSchemaVersion: 1,
          occurrenceKey: `ordered-${String(sequence)}`,
          occurredAt: h.clock.now(),
          facts: { subjectId: 'subject-1', title: `Ordered ${String(sequence)}`, sequence },
        })
      );
    }

    await h.runtime.runNext();
    await h.runtime.runNext();
    await h.runtime.runNext();
    await h.runtime.runNext();
    const deliveries = h.deliveries.store
      .list()
      .sort((left, right) => (left.streamSequence ?? 0) - (right.streamSequence ?? 0));
    expect(deliveries.map((delivery) => delivery.status)).toEqual(['ready', 'ready']);

    const predecessorDispatch = h.runtime.runNext();
    await firstEntered;
    expect(h.deliveries.store.get(deliveries[0]?.id ?? '')?.status).toBe('sending');

    await h.runtime.runNext();
    expect(h.deliveries.store.get(deliveries[1]?.id ?? '')?.status).toBe('ready');
    expect(dispatchOrder).toEqual([1]);

    releaseFirst();
    await predecessorDispatch;
    expect(h.deliveries.store.get(deliveries[0]?.id ?? '')?.status).toBe('accepted');

    h.clock.advance(11 * 60 * 1000);
    const enqueueRecovery = h.runtime.enqueuer<{ thresholdMinutes: number }>(
      QUEUE_NAMES.NP_RECOVERY
    );
    expectOk(await enqueueRecovery({ thresholdMinutes: 10 }));
    await h.runtime.runAll();

    expect(dispatchOrder).toEqual([1, 2]);
    expect(h.deliveries.store.get(deliveries[1]?.id ?? '')?.status).toBe('accepted');
    expect(h.attempts.store.list().map((attempt) => attempt.attemptNumber)).toEqual([1, 1]);
  });
});
