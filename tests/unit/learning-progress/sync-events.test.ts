/**
 * Sync Events Use Case Tests
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_EVENTS_PER_REQUEST,
  MAX_EVENTS_PER_USER,
  type LearningProgressEvent,
} from '@/modules/learning-progress/core/types.js';
import { syncEvents } from '@/modules/learning-progress/core/usecases/sync-events.js';

import {
  makeFakeLearningProgressRepo,
  createTestContentProgressedEvent,
} from '../../fixtures/fakes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('syncEvents', () => {
  it('returns success for empty events array', async () => {
    const repo = makeFakeLearningProgressRepo();

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00Z', events: [] }
    );

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.newEventsCount).toBe(0);
  });

  it('stores new events successfully', async () => {
    const repo = makeFakeLearningProgressRepo();

    const events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
      createTestContentProgressedEvent({
        eventId: 'e2',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00Z', events }
    );

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.newEventsCount).toBe(2);
  });

  it('deduplicates events by eventId', async () => {
    const existingEvents: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
    ];

    const initialEvents = new Map<string, LearningProgressEvent[]>();
    initialEvents.set('user-1', existingEvents);

    const repo = makeFakeLearningProgressRepo({ initialEvents });

    // Try to sync events including a duplicate
    const newEvents: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1', // Duplicate
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
      createTestContentProgressedEvent({
        eventId: 'e2', // New
        payload: { contentId: 'lesson-2', status: 'in_progress' },
      }),
    ];

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00Z', events: newEvents }
    );

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.newEventsCount).toBe(1); // Only e2 is new
  });

  it('rejects request with too many events', async () => {
    const repo = makeFakeLearningProgressRepo();

    // Create more events than allowed
    const events: LearningProgressEvent[] = Array.from(
      { length: MAX_EVENTS_PER_REQUEST + 1 },
      (_, i) =>
        createTestContentProgressedEvent({
          eventId: `e${String(i)}`,
          payload: { contentId: `lesson-${String(i)}`, status: 'in_progress' },
        })
    );

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00Z', events }
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('TooManyEventsError');
  });

  it('rejects when user would exceed total event limit', async () => {
    // Create a repo with events near the limit
    const existingEvents = Array.from({ length: MAX_EVENTS_PER_USER - 5 }, (_, i) =>
      createTestContentProgressedEvent({
        eventId: `existing-${String(i)}`,
        payload: { contentId: `lesson-${String(i)}`, status: 'completed' },
      })
    );

    const initialEvents = new Map<string, LearningProgressEvent[]>();
    initialEvents.set('user-1', existingEvents);

    const repo = makeFakeLearningProgressRepo({ initialEvents });

    // Try to add more events that would exceed limit
    const newEvents = Array.from({ length: 10 }, (_, i) =>
      createTestContentProgressedEvent({
        eventId: `new-${String(i)}`,
        payload: { contentId: `new-lesson-${String(i)}`, status: 'in_progress' },
      })
    );

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00Z', events: newEvents }
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('EventLimitExceededError');
  });

  it('returns database error on failure', async () => {
    const repo = makeFakeLearningProgressRepo({ simulateDbError: true });

    const events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
    ];

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00Z', events }
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('DatabaseError');
  });

  it('isolates events between users', async () => {
    const repo = makeFakeLearningProgressRepo();

    const user1Events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'u1-e1',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];

    const user2Events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'u2-e1',
        payload: { contentId: 'lesson-2', status: 'in_progress' },
      }),
    ];

    // Sync events for user 1
    await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00Z', events: user1Events }
    );

    // Sync events for user 2
    await syncEvents(
      { repo },
      { userId: 'user-2', clientUpdatedAt: '2024-01-15T10:00:00Z', events: user2Events }
    );

    // Verify counts are independent
    const count1 = await repo.getEventCount('user-1');
    const count2 = await repo.getEventCount('user-2');

    expect(count1.isOk()).toBe(true);
    expect(count2.isOk()).toBe(true);
    expect(count1._unsafeUnwrap()).toBe(1);
    expect(count2._unsafeUnwrap()).toBe(1);
  });
});
