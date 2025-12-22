/**
 * Get Progress Use Case Tests
 *
 * Tests the event retrieval logic.
 * Client derives snapshot from events (not tested here).
 */

import { describe, it, expect } from 'vitest';

import { getProgress } from '@/modules/learning-progress/core/usecases/get-progress.js';

import {
  makeFakeLearningProgressRepo,
  createTestContentProgressedEvent,
  createTestOnboardingCompletedEvent,
} from '../../fixtures/fakes.js';

import type { LearningProgressEvent } from '@/modules/learning-progress/core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('getProgress', () => {
  it('returns empty events and cursor for user with no progress', async () => {
    const repo = makeFakeLearningProgressRepo();

    const result = await getProgress({ repo }, { userId: 'user-1', since: undefined });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.events).toEqual([]);
    expect(data.cursor).toBe('');
  });

  it('returns all events when no cursor provided', async () => {
    const events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1',
        occurredAt: '2024-01-15T10:00:00Z',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
      createTestOnboardingCompletedEvent('path-basics', {
        eventId: 'e2',
        occurredAt: '2024-01-15T11:00:00Z',
      }),
    ];

    const initialEvents = new Map<string, LearningProgressEvent[]>();
    initialEvents.set('user-1', events);

    const repo = makeFakeLearningProgressRepo({ initialEvents });

    const result = await getProgress({ repo }, { userId: 'user-1', since: undefined });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    // Should return ALL events when no cursor
    expect(data.events).toHaveLength(2);
    expect(data.events[0]!.eventId).toBe('e1');
    expect(data.events[1]!.eventId).toBe('e2');

    // Cursor should be the latest event timestamp
    expect(data.cursor).toBe('2024-01-15T11:00:00Z');
  });

  it('returns events since cursor when provided', async () => {
    const events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1',
        occurredAt: '2024-01-15T10:00:00Z',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
      createTestContentProgressedEvent({
        eventId: 'e2',
        occurredAt: '2024-01-15T11:00:00Z',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
      createTestContentProgressedEvent({
        eventId: 'e3',
        occurredAt: '2024-01-15T12:00:00Z',
        payload: { contentId: 'lesson-2', status: 'in_progress' },
      }),
    ];

    const initialEvents = new Map<string, LearningProgressEvent[]>();
    initialEvents.set('user-1', events);

    const repo = makeFakeLearningProgressRepo({ initialEvents });

    // Get events since the first event
    const result = await getProgress({ repo }, { userId: 'user-1', since: '2024-01-15T10:30:00Z' });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    // Should return events after the cursor
    expect(data.events).toHaveLength(2);
    expect(data.events[0]!.eventId).toBe('e2');
    expect(data.events[1]!.eventId).toBe('e3');
  });

  it('returns database error on failure', async () => {
    const repo = makeFakeLearningProgressRepo({ simulateDbError: true });

    const result = await getProgress({ repo }, { userId: 'user-1', since: undefined });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('DatabaseError');
  });

  it('returns all events when empty cursor provided', async () => {
    const events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1',
        occurredAt: '2024-01-15T10:00:00Z',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];

    const initialEvents = new Map<string, LearningProgressEvent[]>();
    initialEvents.set('user-1', events);

    const repo = makeFakeLearningProgressRepo({ initialEvents });

    const result = await getProgress({ repo }, { userId: 'user-1', since: '' });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    // Empty since should return ALL events (same as undefined)
    expect(data.events).toHaveLength(1);
    expect(data.events[0]!.eventId).toBe('e1');
  });

  it('isolates progress between users', async () => {
    const user1Events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];
    const user2Events: LearningProgressEvent[] = [
      createTestContentProgressedEvent({
        eventId: 'e2',
        payload: { contentId: 'lesson-2', status: 'in_progress' },
      }),
    ];

    const initialEvents = new Map<string, LearningProgressEvent[]>();
    initialEvents.set('user-1', user1Events);
    initialEvents.set('user-2', user2Events);

    const repo = makeFakeLearningProgressRepo({ initialEvents });

    const result1 = await getProgress({ repo }, { userId: 'user-1', since: undefined });
    const result2 = await getProgress({ repo }, { userId: 'user-2', since: undefined });

    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);

    const data1 = result1._unsafeUnwrap();
    const data2 = result2._unsafeUnwrap();

    // User 1 should only see their events
    expect(data1.events).toHaveLength(1);
    expect(data1.events[0]!.eventId).toBe('e1');

    // User 2 should only see their events
    expect(data2.events).toHaveLength(1);
    expect(data2.events[0]!.eventId).toBe('e2');
  });
});
