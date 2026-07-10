import { describe, expect, it } from 'vitest';

import { applyProviderOutcome } from '@/modules/notification-platform/core/delivery/usecases/apply-provider-outcome.js';
import { recordNotificationEvent } from '@/modules/notification-platform/core/events/usecases/record-notification-event.js';

import { makeFlowHarness, seedFlowRecipient } from './harness.js';
import { expectOk } from '../../../support/index.js';

describe('notification platform happy path flow', () => {
  it('drives event fan-out, render, send, and provider delivery through shared jobs', async () => {
    const h = makeFlowHarness();
    seedFlowRecipient(h);

    const recorded = expectOk(
      await recordNotificationEvent(h, {
        source: 'flow',
        eventType: h.kind.eventType,
        eventSchemaVersion: 1,
        occurrenceKey: 'happy-path-1',
        occurredAt: h.clock.now(),
        facts: { subjectId: 'subject-1', title: 'Happy path notification' },
      })
    );
    expect(recorded.outcome).toBe('created');

    await h.runtime.runAll();

    const logicals = h.logicalNotifications.store.list();
    const deliveries = h.deliveries.store.list();
    expect(logicals).toHaveLength(1);
    expect(logicals[0]).toMatchObject({
      inboxTitle: 'Happy path notification',
      inboxBody: 'Body: Happy path notification',
      inboxVisible: true,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe('accepted');

    expect(
      expectOk(
        await applyProviderOutcome(h, {
          providerRef: deliveries[0]?.providerRef ?? '',
          outcome: 'delivered',
          occurredAt: h.clock.now(),
        })
      ).applied
    ).toBe(true);
    expect(h.deliveries.store.get(deliveries[0]?.id ?? '')?.status).toBe('delivered');

    expect(h.attempts.store.list()).toHaveLength(1);
    expect(h.attempts.store.list()[0]).toMatchObject({
      attemptNumber: 1,
      result: 'accepted',
    });
    const actions = h.audit.store.list().map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'event.accepted',
        'recipient.included',
        'logical.created',
        'delivery.created',
        'delivery.terminal',
      ])
    );
  });
});
