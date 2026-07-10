import { describe, expect, it } from 'vitest';

import { recordNotificationEvent } from '@/modules/notification-platform/core/events/usecases/record-notification-event.js';

import { makeUsecaseHarness } from './harness.js';
import { expectErr, expectOk } from '../../../support/index.js';

describe('recordNotificationEvent', () => {
  it('creates once, audits replay, and detects occurrence-key conflicts', async () => {
    const h = makeUsecaseHarness();
    const input = {
      source: 'test-source',
      eventType: h.kind.eventType,
      eventSchemaVersion: 1,
      occurrenceKey: 'occurrence-1',
      occurredAt: h.clock.now(),
      facts: { subjectId: 'subject-1', title: 'Created' },
    };

    expect(expectOk(await recordNotificationEvent(h, input)).outcome).toBe('created');
    expect(expectOk(await recordNotificationEvent(h, input)).outcome).toBe('duplicate');
    expect(h.events.store.size()).toBe(1);
    expect(h.runtime.pending()).toHaveLength(1);
    expect(h.audit.store.list().map((entry) => entry.action)).toEqual([
      'event.accepted',
      'event.duplicate',
    ]);

    const conflict = expectErr(
      await recordNotificationEvent(h, {
        ...input,
        facts: { subjectId: 'subject-1', title: 'Changed' },
      })
    );
    expect(conflict.type).toBe('EventPayloadConflict');
    expect(h.events.store.list()[0]?.status).toBe('conflicted');
    expect(h.audit.store.list().at(-1)?.action).toBe('event.conflict');
  });
});
