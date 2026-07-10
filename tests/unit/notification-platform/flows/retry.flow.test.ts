import { describe, expect, it } from 'vitest';

import { recordNotificationEvent } from '@/modules/notification-platform/core/events/usecases/record-notification-event.js';

import { makeFlowHarness, seedFlowRecipient } from './harness.js';
import { makeFakeChannelAdapterPort } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('notification platform retry flow', () => {
  it('moves through retry_wait and dispatches a second attempt on an attempt-scoped job', async () => {
    const adapter = makeFakeChannelAdapterPort({
      sendResultValues: [
        {
          classification: 'transient_failure',
          errorCode: 'temporary_failure',
          errorMessage: 'retry later',
        },
        { classification: 'accepted', providerRef: 'provider-after-retry' },
      ],
    });
    const h = makeFlowHarness({ adapter });
    seedFlowRecipient(h);
    expectOk(
      await recordNotificationEvent(h, {
        source: 'flow',
        eventType: h.kind.eventType,
        eventSchemaVersion: 1,
        occurrenceKey: 'retry-1',
        occurredAt: h.clock.now(),
        facts: { subjectId: 'subject-1', title: 'Retry notification' },
      })
    );

    await h.runtime.runNext();
    await h.runtime.runNext();
    await h.runtime.runNext();

    const delivery = h.deliveries.store.list()[0];
    expect(delivery).toBeDefined();
    expect(h.deliveries.store.get(delivery?.id ?? '')?.status).toBe('retry_wait');
    const retryJob = h.runtime.pending()[0];
    expect(retryJob).toMatchObject({
      name: 'np-delivery-send',
      opts: {
        dedupeId: `np-send-${delivery?.id ?? ''}-2`,
        delayMs: expect.any(Number),
      },
    });
    expect(retryJob?.runAt.getTime() ?? 0).toBeGreaterThan(retryJob?.enqueuedAt.getTime() ?? 0);

    await h.runtime.runAll();

    expect(h.deliveries.store.get(delivery?.id ?? '')?.status).toBe('accepted');
    expect(
      h.attempts.store
        .list()
        .sort((left, right) => left.attemptNumber - right.attemptNumber)
        .map((attempt) => [attempt.attemptNumber, attempt.result])
    ).toEqual([
      [1, 'transient_failure'],
      [2, 'accepted'],
    ]);
  });
});
