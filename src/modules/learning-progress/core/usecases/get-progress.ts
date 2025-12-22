/**
 * Get Progress Use Case
 *
 * Retrieves learning progress events for a user.
 * Client derives snapshot from events.
 */

import { ok, err, type Result } from 'neverthrow';

import { filterEventsSinceCursor } from '../reducer.js';

import type { LearningProgressError } from '../errors.js';
import type { LearningProgressRepository } from '../ports.js';
import type { LearningProgressEvent, GetProgressResponse } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for get progress use case.
 */
export interface GetProgressDeps {
  repo: LearningProgressRepository;
}

/**
 * Input for get progress use case.
 */
export interface GetProgressInput {
  /** User identifier */
  userId: string;
  /** Optional cursor (ISO timestamp) to get events since */
  since: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieves learning progress events for a user.
 *
 * If no cursor provided, returns ALL events so client can reconstruct state.
 * If cursor provided, returns only events since that cursor.
 *
 * @param deps - Repository dependencies
 * @param input - User ID and optional cursor
 * @returns Progress response with events and cursor
 */
export async function getProgress(
  deps: GetProgressDeps,
  input: GetProgressInput
): Promise<Result<GetProgressResponse, LearningProgressError>> {
  const { repo } = deps;
  const { userId, since } = input;

  // Fetch all progress data for the user
  const progressResult = await repo.getProgress(userId);

  if (progressResult.isErr()) {
    return err(progressResult.error);
  }

  const progressData = progressResult.value;

  // Handle case where user has no progress
  if (progressData === null) {
    return ok({
      events: [],
      cursor: '',
    });
  }

  const { events, lastEventAt } = progressData;

  // Determine events to return based on cursor
  // If no cursor provided, return ALL events so client can reconstruct state
  let eventsToReturn: LearningProgressEvent[];
  if (since !== undefined && since !== '') {
    eventsToReturn = filterEventsSinceCursor(events, since);
  } else {
    eventsToReturn = events;
  }

  return ok({
    events: eventsToReturn,
    cursor: lastEventAt ?? '',
  });
}
