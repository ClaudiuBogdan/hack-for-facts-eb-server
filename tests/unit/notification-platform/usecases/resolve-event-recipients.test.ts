import { describe, expect, it } from 'vitest';

import { resolveEventRecipients } from '@/modules/notification-platform/core/inbox/usecases/resolve-event-recipients.js';

import { makeUsecaseHarness } from './harness.js';
import {
  makeNotificationEvent,
  makeSubscription,
  makeUserNotificationPreferences,
} from '../../../fixtures/notification-platform/index.js';
import { expectErr, expectOk } from '../../../support/index.js';

describe('resolveEventRecipients', () => {
  it('pages eligible recipients, audits skips, and replays fan-out as a no-op', async () => {
    const h = makeUsecaseHarness();
    const event = makeNotificationEvent(h, {
      id: 'event-1',
      eventType: h.kind.eventType,
      facts: { subjectId: 'subject-1', title: 'Created' },
    });
    h.events.store.put(event);
    h.subscriptions.store.seed([
      makeSubscription(h, { id: 'sub-1', userId: 'user-1' }),
      makeSubscription(h, { id: 'sub-2', userId: 'user-2' }),
    ]);
    h.preferences.store.put(
      makeUserNotificationPreferences(h, { userId: 'user-2', globalOptionalEnabled: false })
    );

    const first = expectOk(await resolveEventRecipients(h, { eventId: event.id, pageSize: 1 }));
    expect(first).toEqual({ created: 1, skipped: 1, resumed: false });
    expect(h.logicalNotifications.store.size()).toBe(1);
    expect(h.deliveries.store.size()).toBe(1);
    expect(h.audit.store.list().map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['recipient.included', 'recipient.skipped', 'logical.created'])
    );

    const replay = expectOk(await resolveEventRecipients(h, { eventId: event.id }));
    expect(replay.created).toBe(0);
    expect(h.logicalNotifications.store.size()).toBe(1);
    expect(h.deliveries.store.size()).toBe(1);
  });

  it('repairs delivery planning on replay after logical insertion succeeded', async () => {
    const h = makeUsecaseHarness();
    const event = makeNotificationEvent(h, {
      id: 'event-1',
      eventType: h.kind.eventType,
      facts: { subjectId: 'subject-1', title: 'Repair me' },
    });
    h.events.store.put(event);
    h.subscriptions.store.put(makeSubscription(h, { id: 'sub-1', userId: 'user-1' }));
    h.deliveries.faults.fail('insertIdempotent', {
      error: { type: 'DatabaseError', message: 'planned fault', retryable: true },
    });

    expect(expectErr(await resolveEventRecipients(h, { eventId: event.id })).type).toBe(
      'DatabaseError'
    );
    expect(h.logicalNotifications.store.size()).toBe(1);
    expect(h.deliveries.store.size()).toBe(0);

    h.clock.advance(121_000);
    const replay = expectOk(await resolveEventRecipients(h, { eventId: event.id }));
    expect(replay.created).toBe(0);
    expect(h.logicalNotifications.store.size()).toBe(1);
    expect(h.deliveries.store.size()).toBe(1);
    expect(
      h.audit.store.list().filter((entry) => entry.action === 'recipient.included')
    ).toHaveLength(1);
  });

  it('skips anonymized users before eligibility evaluation', async () => {
    const h = makeUsecaseHarness();
    const event = makeNotificationEvent(h, {
      id: 'event-1',
      eventType: h.kind.eventType,
      facts: { subjectId: 'subject-1', title: 'Deleted user' },
    });
    h.events.store.put(event);
    h.subscriptions.store.put(makeSubscription(h, { id: 'sub-1', userId: 'user-1' }));
    h.anonymization.anonymizedUserIds.add('user-1');

    expectOk(await resolveEventRecipients(h, { eventId: event.id }));
    expect(h.logicalNotifications.store.size()).toBe(0);
    expect(h.preferences.faults.callCount('getForUser')).toBe(0);
    expect(h.audit.store.list()[0]).toMatchObject({
      action: 'recipient.skipped',
      reason: 'user_anonymized',
    });
  });
});
