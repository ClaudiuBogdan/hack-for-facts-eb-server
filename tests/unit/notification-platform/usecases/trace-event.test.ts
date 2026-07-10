import { describe, expect, it } from 'vitest';

import { traceEvent } from '@/modules/notification-platform/core/admin/usecases/trace-event.js';

import { makeUsecaseHarness } from './harness.js';
import {
  makeDelivery,
  makeDeliveryAttempt,
  makeLogicalNotification,
  makeNotificationEvent,
} from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('traceEvent', () => {
  it('builds a redacted event tree with attempts and audit', async () => {
    const h = makeUsecaseHarness();
    h.events.store.put(makeNotificationEvent(h, { id: 'event-1' }));
    h.logicalNotifications.store.put(
      makeLogicalNotification(h, { id: 'logical-1', eventId: 'event-1' })
    );
    h.deliveries.store.put(
      makeDelivery(h, { id: 'delivery-1', logicalNotificationId: 'logical-1' })
    );
    h.attempts.store.put(makeDeliveryAttempt(h, { deliveryId: 'delivery-1' }));
    await h.audit.append({
      action: 'event.accepted',
      occurredAt: h.clock.now(),
      actor: 'system',
      eventId: 'event-1',
    });
    const trace = expectOk(await traceEvent(h, { eventId: 'event-1' }));
    const delivery = trace.logicalNotifications[0]?.deliveries[0]?.delivery;
    expect(delivery).not.toHaveProperty('renderedHtml');
    expect(delivery).not.toHaveProperty('destinationFingerprint');
    expect(trace.event).not.toHaveProperty('facts');
    expect(trace.logicalNotifications[0]?.logicalNotification).not.toHaveProperty('recipientFacts');
    expect(trace.logicalNotifications[0]?.deliveries[0]?.attempts).toHaveLength(1);
    expect(trace.logicalNotifications[0]?.deliveries[0]?.attempts[0]).not.toHaveProperty(
      'errorMessage'
    );
    expect(trace.auditEntries).toHaveLength(1);
    expect(trace.auditEntries[0]).not.toHaveProperty('details');
  });
});
