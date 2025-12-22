/**
 * Learning Progress Module - Event Reducer
 *
 * Pure function that derives a snapshot from an event log.
 * This implements the event-sourcing pattern where the snapshot
 * is always computed from the full event history.
 */

import {
  SNAPSHOT_VERSION,
  STATUS_PRECEDENCE,
  isContentProgressedEvent,
  isOnboardingCompletedEvent,
  isOnboardingResetEvent,
  isActivePathSetEvent,
  isProgressResetEvent,
  type LearningProgressEvent,
  type LearningProgressSnapshot,
  type LearningContentProgress,
  type LearningContentStatus,
  type LearningStreak,
  type ContentProgressedEvent,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an empty snapshot with default values.
 */
export function createEmptySnapshot(): LearningProgressSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    activePath: null,
    onboardingCompletedAt: null,
    onboardingPathId: null,
    content: {},
    streak: {
      currentStreak: 0,
      longestStreak: 0,
      lastActivityDate: null,
    },
    lastUpdated: null,
  };
}

/**
 * Compares two events for sorting.
 * Primary: occurredAt ascending
 * Secondary: eventId ascending (for deterministic ordering)
 */
function compareEvents(a: LearningProgressEvent, b: LearningProgressEvent): number {
  const timeCompare = a.occurredAt.localeCompare(b.occurredAt);
  if (timeCompare !== 0) {
    return timeCompare;
  }
  return a.eventId.localeCompare(b.eventId);
}

/**
 * Extracts the date portion (YYYY-MM-DD) from an ISO timestamp.
 */
function extractDate(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Calculates the difference in days between two dates.
 */
function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffMs = Math.abs(d2.getTime() - d1.getTime());
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Updates streak based on a completion event.
 */
function updateStreak(streak: LearningStreak, eventDate: string): LearningStreak {
  const activityDate = extractDate(eventDate);

  // First activity ever
  if (streak.lastActivityDate === null) {
    return {
      currentStreak: 1,
      longestStreak: 1,
      lastActivityDate: activityDate,
    };
  }

  // Same day - no streak change
  if (streak.lastActivityDate === activityDate) {
    return streak;
  }

  const daysDiff = daysBetween(streak.lastActivityDate, activityDate);

  // Consecutive day - increment streak
  if (daysDiff === 1) {
    const newStreak = streak.currentStreak + 1;
    return {
      currentStreak: newStreak,
      longestStreak: Math.max(streak.longestStreak, newStreak),
      lastActivityDate: activityDate,
    };
  }

  // Gap in activity - reset current streak
  return {
    currentStreak: 1,
    longestStreak: streak.longestStreak,
    lastActivityDate: activityDate,
  };
}

/**
 * Determines if a status transition should update the content progress.
 * Uses status precedence to prevent regressions.
 */
function shouldUpdateStatus(
  currentStatus: LearningContentStatus,
  newStatus: LearningContentStatus
): boolean {
  return STATUS_PRECEDENCE[newStatus] >= STATUS_PRECEDENCE[currentStatus];
}

/**
 * Checks if a status represents completion (for streak tracking).
 */
function isCompletionStatus(status: LearningContentStatus): boolean {
  return status === 'completed' || status === 'passed';
}

/**
 * Applies a content.progressed event to a snapshot.
 */
function applyContentProgressedEvent(
  snapshot: LearningProgressSnapshot,
  event: ContentProgressedEvent
): LearningProgressSnapshot {
  const { payload, occurredAt } = event;
  const { contentId, status, score, interaction } = payload;

  // Get or create content progress
  const existingProgress = snapshot.content[contentId];
  const currentStatus = existingProgress?.status ?? 'not_started';

  // Check if we should update (status precedence)
  const shouldUpdate = shouldUpdateStatus(currentStatus, status);

  // Prepare new content progress
  let newProgress: LearningContentProgress;

  if (existingProgress !== undefined) {
    newProgress = { ...existingProgress };

    // Update status if allowed by precedence
    if (shouldUpdate) {
      newProgress.status = status;
    }

    // Always update lastAttemptAt
    newProgress.lastAttemptAt = occurredAt;

    // Update score (keep max)
    if (score !== undefined) {
      const currentScore = newProgress.score ?? 0;
      newProgress.score = Math.max(currentScore, score);
    }

    // Set completedAt on first completion
    if (
      isCompletionStatus(status) &&
      newProgress.completedAt === undefined &&
      isCompletionStatus(newProgress.status)
    ) {
      newProgress.completedAt = occurredAt;
    }

    // Handle interaction updates
    if (interaction !== undefined) {
      newProgress.interactions = {
        ...newProgress.interactions,
        [interaction.interactionId]: interaction.state,
      };
    }
  } else {
    // New content progress
    newProgress = {
      contentId,
      status,
      lastAttemptAt: occurredAt,
      interactions: {},
    };

    if (score !== undefined) {
      newProgress.score = score;
    }

    if (isCompletionStatus(status)) {
      newProgress.completedAt = occurredAt;
    }

    if (interaction !== undefined) {
      newProgress.interactions[interaction.interactionId] = interaction.state;
    }
  }

  // Update streak on completion (only if transitioning to completed/passed)
  let newStreak = snapshot.streak;
  const wasCompleted =
    existingProgress !== undefined && isCompletionStatus(existingProgress.status);
  const isNowCompleted = isCompletionStatus(status);

  if (isNowCompleted && !wasCompleted) {
    newStreak = updateStreak(snapshot.streak, occurredAt);
  }

  return {
    ...snapshot,
    content: {
      ...snapshot.content,
      [contentId]: newProgress,
    },
    streak: newStreak,
  };
}

/**
 * Applies a single event to a snapshot, returning the new snapshot.
 */
function applyEvent(
  snapshot: LearningProgressSnapshot,
  event: LearningProgressEvent
): LearningProgressSnapshot {
  // Update lastUpdated
  let result: LearningProgressSnapshot = {
    ...snapshot,
    lastUpdated:
      snapshot.lastUpdated === null || event.occurredAt > snapshot.lastUpdated
        ? event.occurredAt
        : snapshot.lastUpdated,
  };

  // Apply event-specific changes
  if (isContentProgressedEvent(event)) {
    result = applyContentProgressedEvent(result, event);
  } else if (isOnboardingCompletedEvent(event)) {
    result = {
      ...result,
      onboardingCompletedAt: event.occurredAt,
      onboardingPathId: event.payload.pathId,
      // Also set active path when completing onboarding
      activePath: event.payload.pathId,
    };
  } else if (isOnboardingResetEvent(event)) {
    result = {
      ...result,
      onboardingCompletedAt: null,
      onboardingPathId: null,
    };
  } else if (isActivePathSetEvent(event)) {
    result = {
      ...result,
      activePath: event.payload.pathId,
    };
  } else if (isProgressResetEvent(event)) {
    // Reset all progress but keep lastUpdated
    result = {
      ...createEmptySnapshot(),
      lastUpdated: event.occurredAt,
    };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Reducer Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduces an event log to a snapshot.
 *
 * This is a pure function that:
 * 1. Sorts events by occurredAt (then eventId for ties)
 * 2. Applies each event in order
 * 3. Returns the final snapshot state
 *
 * @param events - Array of learning progress events
 * @returns The derived snapshot
 */
export function reduceEventsToSnapshot(events: LearningProgressEvent[]): LearningProgressSnapshot {
  if (events.length === 0) {
    return createEmptySnapshot();
  }

  // Sort events for deterministic processing
  const sortedEvents = [...events].sort(compareEvents);

  // Reduce to final snapshot
  let snapshot = createEmptySnapshot();
  for (const event of sortedEvents) {
    snapshot = applyEvent(snapshot, event);
  }

  return snapshot;
}

/**
 * Filters events that occurred after a given cursor timestamp.
 *
 * @param events - Array of events to filter
 * @param cursor - ISO timestamp cursor (exclusive)
 * @returns Events with occurredAt > cursor
 */
export function filterEventsSinceCursor(
  events: LearningProgressEvent[],
  cursor: string
): LearningProgressEvent[] {
  return events.filter((event) => event.occurredAt > cursor);
}

/**
 * Merges two event arrays, deduplicating by eventId.
 * Keeps the first occurrence of each eventId.
 *
 * @param existing - Existing events
 * @param incoming - New events to merge
 * @returns Merged and deduplicated events
 */
export function mergeEvents(
  existing: LearningProgressEvent[],
  incoming: LearningProgressEvent[]
): LearningProgressEvent[] {
  const eventMap = new Map<string, LearningProgressEvent>();

  // Add existing events first
  for (const event of existing) {
    eventMap.set(event.eventId, event);
  }

  // Add incoming events (won't overwrite existing due to Map behavior)
  for (const event of incoming) {
    if (!eventMap.has(event.eventId)) {
      eventMap.set(event.eventId, event);
    }
  }

  return Array.from(eventMap.values());
}

/**
 * Counts how many events in the incoming array are new (not in existing).
 *
 * @param existing - Existing events
 * @param incoming - New events to check
 * @returns Count of truly new events
 */
export function countNewEvents(
  existing: LearningProgressEvent[],
  incoming: LearningProgressEvent[]
): number {
  const existingIds = new Set(existing.map((e) => e.eventId));
  return incoming.filter((e) => !existingIds.has(e.eventId)).length;
}
