/**
 * Learning Progress Module - Ports (Interfaces)
 *
 * Repository interfaces for learning progress data access.
 * These define WHAT we need, not HOW it's implemented.
 */

import type { LearningProgressError } from './errors.js';
import type { LearningProgressEvent } from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Repository Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * User's learning progress data from the database.
 */
export interface LearningProgressData {
  /** All stored events */
  events: LearningProgressEvent[];
  /** Timestamp of the most recent event (cursor) */
  lastEventAt: string | null;
  /** Total number of events stored */
  eventCount: number;
}

/**
 * Result of upserting events.
 */
export interface UpsertEventsResult {
  /** Number of new events added (excludes duplicates) */
  newEventsCount: number;
  /** Total events after upsert */
  totalEventCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for learning progress data access.
 */
export interface LearningProgressRepository {
  /**
   * Get all learning progress data for a user.
   * Returns null if the user has no progress data.
   */
  getProgress(userId: string): Promise<Result<LearningProgressData | null, LearningProgressError>>;

  /**
   * Upsert events for a user (idempotent by eventId).
   * - Merges new events with existing events
   * - Deduplicates by eventId
   * - Updates lastEventAt and eventCount
   *
   * @param userId - User identifier
   * @param events - Events to upsert
   * @returns Result with counts of new and total events
   */
  upsertEvents(
    userId: string,
    events: LearningProgressEvent[]
  ): Promise<Result<UpsertEventsResult, LearningProgressError>>;

  /**
   * Get the current event count for a user.
   * Used for limit checking before upsert.
   */
  getEventCount(userId: string): Promise<Result<number, LearningProgressError>>;
}
