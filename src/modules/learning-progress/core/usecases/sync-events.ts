/**
 * Sync Events Use Case
 *
 * Upserts learning progress events for a user.
 * Events are deduplicated by eventId (idempotent).
 */

import { ok, err, type Result } from 'neverthrow';

import {
  createTooManyEventsError,
  createEventLimitExceededError,
  type LearningProgressError,
} from '../errors.js';
import {
  MAX_EVENTS_PER_REQUEST,
  MAX_EVENTS_PER_USER,
  type LearningProgressEvent,
} from '../types.js';

import type { LearningProgressRepository } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for sync events use case.
 */
export interface SyncEventsDeps {
  repo: LearningProgressRepository;
}

/**
 * Input for sync events use case.
 */
export interface SyncEventsInput {
  /** User identifier */
  userId: string;
  /** Client's timestamp when sync was initiated */
  clientUpdatedAt: string;
  /** Events to sync */
  events: LearningProgressEvent[];
}

/**
 * Output for sync events use case.
 */
export interface SyncEventsOutput {
  /** Number of new events added */
  newEventsCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Syncs learning progress events for a user.
 *
 * - Validates event count limits
 * - Upserts events (deduplicates by eventId)
 * - Returns count of new events added
 *
 * @param deps - Repository dependencies
 * @param input - User ID and events to sync
 * @returns Result with count of new events
 */
export async function syncEvents(
  deps: SyncEventsDeps,
  input: SyncEventsInput
): Promise<Result<SyncEventsOutput, LearningProgressError>> {
  const { repo } = deps;
  const { userId, events } = input;

  // Validate request size
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return err(createTooManyEventsError(MAX_EVENTS_PER_REQUEST, events.length));
  }

  // Empty request is a no-op
  if (events.length === 0) {
    return ok({ newEventsCount: 0 });
  }

  // Check current event count against limit
  const countResult = await repo.getEventCount(userId);
  if (countResult.isErr()) {
    return err(countResult.error);
  }

  const currentCount = countResult.value;

  // Check if adding all events would exceed limit
  // Note: Some events may be duplicates, but we check worst case
  if (currentCount + events.length > MAX_EVENTS_PER_USER) {
    return err(createEventLimitExceededError(MAX_EVENTS_PER_USER, currentCount));
  }

  // Upsert events
  const upsertResult = await repo.upsertEvents(userId, events);
  if (upsertResult.isErr()) {
    return err(upsertResult.error);
  }

  return ok({ newEventsCount: upsertResult.value.newEventsCount });
}
