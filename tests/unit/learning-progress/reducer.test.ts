/**
 * Learning Progress Reducer Tests
 *
 * Tests for the pure event reducer that derives snapshots from event logs.
 */

import { describe, it, expect } from 'vitest';

import {
  reduceEventsToSnapshot,
  filterEventsSinceCursor,
  mergeEvents,
  countNewEvents,
  createEmptySnapshot,
} from '@/modules/learning-progress/core/reducer.js';

import type {
  LearningProgressEvent,
  ContentProgressedEvent,
  OnboardingCompletedEvent,
  OnboardingResetEvent,
  ActivePathSetEvent,
  ProgressResetEvent,
} from '@/modules/learning-progress/core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const createContentProgressedEvent = (
  overrides: Partial<ContentProgressedEvent> & { payload: ContentProgressedEvent['payload'] }
): ContentProgressedEvent => ({
  eventId: 'event-1',
  occurredAt: '2024-01-15T10:00:00Z',
  clientId: 'client-1',
  type: 'content.progressed',
  ...overrides,
});

const createOnboardingCompletedEvent = (
  pathId: string,
  overrides: Partial<OnboardingCompletedEvent> = {}
): OnboardingCompletedEvent => ({
  eventId: 'onboarding-1',
  occurredAt: '2024-01-15T10:00:00Z',
  clientId: 'client-1',
  type: 'onboarding.completed',
  payload: { pathId },
  ...overrides,
});

const createOnboardingResetEvent = (
  overrides: Partial<OnboardingResetEvent> = {}
): OnboardingResetEvent => ({
  eventId: 'reset-1',
  occurredAt: '2024-01-15T10:00:00Z',
  clientId: 'client-1',
  type: 'onboarding.reset',
  ...overrides,
});

const createActivePathSetEvent = (
  pathId: string | null,
  overrides: Partial<ActivePathSetEvent> = {}
): ActivePathSetEvent => ({
  eventId: 'path-1',
  occurredAt: '2024-01-15T10:00:00Z',
  clientId: 'client-1',
  type: 'activePath.set',
  payload: { pathId },
  ...overrides,
});

const createProgressResetEvent = (
  overrides: Partial<ProgressResetEvent> = {}
): ProgressResetEvent => ({
  eventId: 'progress-reset-1',
  occurredAt: '2024-01-15T10:00:00Z',
  clientId: 'client-1',
  type: 'progress.reset',
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// createEmptySnapshot Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createEmptySnapshot', () => {
  it('returns a snapshot with default values', () => {
    const snapshot = createEmptySnapshot();

    expect(snapshot.version).toBe(1);
    expect(snapshot.activePath).toBeNull();
    expect(snapshot.onboardingCompletedAt).toBeNull();
    expect(snapshot.onboardingPathId).toBeNull();
    expect(snapshot.content).toEqual({});
    expect(snapshot.streak.currentStreak).toBe(0);
    expect(snapshot.streak.longestStreak).toBe(0);
    expect(snapshot.streak.lastActivityDate).toBeNull();
    expect(snapshot.lastUpdated).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reduceEventsToSnapshot Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('reduceEventsToSnapshot', () => {
  it('returns empty snapshot for empty event array', () => {
    const snapshot = reduceEventsToSnapshot([]);

    expect(snapshot.version).toBe(1);
    expect(snapshot.content).toEqual({});
    expect(snapshot.lastUpdated).toBeNull();
  });

  describe('content.progressed events', () => {
    it('creates content progress from first event', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          payload: {
            contentId: 'lesson-1',
            status: 'in_progress',
          },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);
      const progress = snapshot.content['lesson-1'];

      expect(progress).toBeDefined();
      expect(progress?.status).toBe('in_progress');
      expect(progress?.lastAttemptAt).toBe('2024-01-15T10:00:00Z');
    });

    it('updates status following precedence rules', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'in_progress' },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.content['lesson-1']!.status).toBe('completed');
    });

    it('does not regress status based on precedence', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
          payload: { contentId: 'lesson-1', status: 'in_progress' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      // Should stay at 'completed' (higher precedence)
      expect(snapshot.content['lesson-1']!.status).toBe('completed');
    });

    it('keeps max score across attempts', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'quiz-1', status: 'in_progress', score: 60 },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
          payload: { contentId: 'quiz-1', status: 'passed', score: 85 },
        }),
        createContentProgressedEvent({
          eventId: 'e3',
          occurredAt: '2024-01-15T12:00:00Z',
          payload: { contentId: 'quiz-1', status: 'passed', score: 75 },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.content['quiz-1']!.score).toBe(85);
    });

    it('sets completedAt on first completion', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'in_progress' },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.content['lesson-1']!.completedAt).toBe('2024-01-15T11:00:00Z');
    });

    it('handles interaction state updates', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          payload: {
            contentId: 'quiz-1',
            status: 'in_progress',
            interaction: {
              interactionId: 'q1',
              state: { answer: 'A', correct: true },
            },
          },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.content['quiz-1']!.interactions['q1']).toEqual({
        answer: 'A',
        correct: true,
      });
    });

    it('handles interaction removal (null state)', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: {
            contentId: 'quiz-1',
            status: 'in_progress',
            interaction: {
              interactionId: 'q1',
              state: { answer: 'A' },
            },
          },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
          payload: {
            contentId: 'quiz-1',
            status: 'in_progress',
            interaction: {
              interactionId: 'q1',
              state: null,
            },
          },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.content['quiz-1']!.interactions['q1']).toBeNull();
    });
  });

  describe('onboarding events', () => {
    it('sets onboarding state on completion', () => {
      const events: LearningProgressEvent[] = [
        createOnboardingCompletedEvent('path-budget-basics'),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.onboardingCompletedAt).toBe('2024-01-15T10:00:00Z');
      expect(snapshot.onboardingPathId).toBe('path-budget-basics');
      expect(snapshot.activePath).toBe('path-budget-basics');
    });

    it('clears onboarding state on reset', () => {
      const events: LearningProgressEvent[] = [
        createOnboardingCompletedEvent('path-budget-basics', {
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
        }),
        createOnboardingResetEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.onboardingCompletedAt).toBeNull();
      expect(snapshot.onboardingPathId).toBeNull();
    });
  });

  describe('activePath events', () => {
    it('sets active path', () => {
      const events: LearningProgressEvent[] = [createActivePathSetEvent('path-advanced')];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.activePath).toBe('path-advanced');
    });

    it('clears active path with null', () => {
      const events: LearningProgressEvent[] = [
        createActivePathSetEvent('path-advanced', {
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
        }),
        createActivePathSetEvent(null, {
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.activePath).toBeNull();
    });
  });

  describe('progress.reset events', () => {
    it('resets all progress to empty state', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createOnboardingCompletedEvent('path-basics', {
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
        }),
        createProgressResetEvent({
          eventId: 'e3',
          occurredAt: '2024-01-15T12:00:00Z',
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      // All progress should be reset
      expect(snapshot.content).toEqual({});
      expect(snapshot.activePath).toBeNull();
      expect(snapshot.onboardingCompletedAt).toBeNull();
      expect(snapshot.onboardingPathId).toBeNull();
      expect(snapshot.streak.currentStreak).toBe(0);
      expect(snapshot.streak.longestStreak).toBe(0);
      // lastUpdated should be set to the reset event time
      expect(snapshot.lastUpdated).toBe('2024-01-15T12:00:00Z');
    });

    it('allows new progress after reset', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createProgressResetEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
        }),
        createContentProgressedEvent({
          eventId: 'e3',
          occurredAt: '2024-01-15T12:00:00Z',
          payload: { contentId: 'lesson-2', status: 'in_progress' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      // Old progress should be gone
      expect(snapshot.content['lesson-1']).toBeUndefined();
      // New progress should be present
      expect(snapshot.content['lesson-2']).toBeDefined();
      expect(snapshot.content['lesson-2']!.status).toBe('in_progress');
    });
  });

  describe('streak calculation', () => {
    it('increments streak on consecutive day completions', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-16T10:00:00Z',
          payload: { contentId: 'lesson-2', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'e3',
          occurredAt: '2024-01-17T10:00:00Z',
          payload: { contentId: 'lesson-3', status: 'completed' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.streak.currentStreak).toBe(3);
      expect(snapshot.streak.longestStreak).toBe(3);
      expect(snapshot.streak.lastActivityDate).toBe('2024-01-17');
    });

    it('resets streak after gap in activity', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-16T10:00:00Z',
          payload: { contentId: 'lesson-2', status: 'completed' },
        }),
        // Gap: Jan 17 is missing
        createContentProgressedEvent({
          eventId: 'e3',
          occurredAt: '2024-01-18T10:00:00Z',
          payload: { contentId: 'lesson-3', status: 'completed' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.streak.currentStreak).toBe(1);
      expect(snapshot.streak.longestStreak).toBe(2);
    });

    it('does not count same-day completions twice', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T14:00:00Z',
          payload: { contentId: 'lesson-2', status: 'completed' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.streak.currentStreak).toBe(1);
    });
  });

  describe('event ordering', () => {
    it('sorts events by occurredAt', () => {
      // Events in wrong order
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T11:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'in_progress' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      // Should process in_progress first, then completed
      expect(snapshot.content['lesson-1']!.status).toBe('completed');
    });

    it('tie-breaks by eventId for deterministic ordering', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'b-event',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'a-event',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'in_progress' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      // 'a-event' comes before 'b-event' alphabetically
      // So in_progress is applied first, then completed
      expect(snapshot.content['lesson-1']!.status).toBe('completed');
    });
  });

  describe('lastUpdated tracking', () => {
    it('sets lastUpdated to max occurredAt', () => {
      const events: LearningProgressEvent[] = [
        createContentProgressedEvent({
          eventId: 'e1',
          occurredAt: '2024-01-15T10:00:00Z',
          payload: { contentId: 'lesson-1', status: 'in_progress' },
        }),
        createContentProgressedEvent({
          eventId: 'e2',
          occurredAt: '2024-01-15T12:00:00Z',
          payload: { contentId: 'lesson-2', status: 'completed' },
        }),
        createContentProgressedEvent({
          eventId: 'e3',
          occurredAt: '2024-01-15T11:00:00Z',
          payload: { contentId: 'lesson-1', status: 'completed' },
        }),
      ];

      const snapshot = reduceEventsToSnapshot(events);

      expect(snapshot.lastUpdated).toBe('2024-01-15T12:00:00Z');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// filterEventsSinceCursor Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('filterEventsSinceCursor', () => {
  it('returns events after cursor', () => {
    const events: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        occurredAt: '2024-01-15T10:00:00Z',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
      createContentProgressedEvent({
        eventId: 'e2',
        occurredAt: '2024-01-15T11:00:00Z',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
      createContentProgressedEvent({
        eventId: 'e3',
        occurredAt: '2024-01-15T12:00:00Z',
        payload: { contentId: 'lesson-2', status: 'in_progress' },
      }),
    ];

    const filtered = filterEventsSinceCursor(events, '2024-01-15T10:30:00Z');

    expect(filtered).toHaveLength(2);
    expect(filtered[0]!.eventId).toBe('e2');
    expect(filtered[1]!.eventId).toBe('e3');
  });

  it('returns empty array when cursor is after all events', () => {
    const events: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        occurredAt: '2024-01-15T10:00:00Z',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
    ];

    const filtered = filterEventsSinceCursor(events, '2024-01-15T12:00:00Z');

    expect(filtered).toHaveLength(0);
  });

  it('returns all events when cursor is before all events', () => {
    const events: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        occurredAt: '2024-01-15T10:00:00Z',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
      createContentProgressedEvent({
        eventId: 'e2',
        occurredAt: '2024-01-15T11:00:00Z',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];

    const filtered = filterEventsSinceCursor(events, '2024-01-14T00:00:00Z');

    expect(filtered).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeEvents Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeEvents', () => {
  it('combines events from both arrays', () => {
    const existing: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
    ];

    const incoming: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e2',
        payload: { contentId: 'lesson-2', status: 'completed' },
      }),
    ];

    const merged = mergeEvents(existing, incoming);

    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.eventId)).toContain('e1');
    expect(merged.map((e) => e.eventId)).toContain('e2');
  });

  it('deduplicates by eventId', () => {
    const existing: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        occurredAt: '2024-01-15T10:00:00Z',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
    ];

    const incoming: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1', // Same eventId
        occurredAt: '2024-01-15T11:00:00Z',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];

    const merged = mergeEvents(existing, incoming);

    expect(merged).toHaveLength(1);
    // Should keep existing (first occurrence)
    expect(merged[0]!.occurredAt).toBe('2024-01-15T10:00:00Z');
  });

  it('handles empty arrays', () => {
    const existing: LearningProgressEvent[] = [];
    const incoming: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];

    const merged = mergeEvents(existing, incoming);

    expect(merged).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countNewEvents Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('countNewEvents', () => {
  it('counts events not in existing', () => {
    const existing: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
    ];

    const incoming: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1', // Duplicate
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
      createContentProgressedEvent({
        eventId: 'e2', // New
        payload: { contentId: 'lesson-2', status: 'completed' },
      }),
      createContentProgressedEvent({
        eventId: 'e3', // New
        payload: { contentId: 'lesson-3', status: 'in_progress' },
      }),
    ];

    const count = countNewEvents(existing, incoming);

    expect(count).toBe(2);
  });

  it('returns 0 when all events are duplicates', () => {
    const existing: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
    ];

    const incoming: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'completed' },
      }),
    ];

    const count = countNewEvents(existing, incoming);

    expect(count).toBe(0);
  });

  it('returns incoming length when no existing events', () => {
    const existing: LearningProgressEvent[] = [];
    const incoming: LearningProgressEvent[] = [
      createContentProgressedEvent({
        eventId: 'e1',
        payload: { contentId: 'lesson-1', status: 'in_progress' },
      }),
      createContentProgressedEvent({
        eventId: 'e2',
        payload: { contentId: 'lesson-2', status: 'completed' },
      }),
    ];

    const count = countNewEvents(existing, incoming);

    expect(count).toBe(2);
  });
});
