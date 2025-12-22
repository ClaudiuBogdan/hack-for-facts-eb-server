/**
 * Learning Progress Repository - Kysely Implementation
 *
 * Implements the LearningProgressRepository interface using Kysely.
 * Stores all events in a JSONB array per user row.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { createDatabaseError, type LearningProgressError } from '../../core/errors.js';
import { mergeEvents, countNewEvents } from '../../core/reducer.js';

import type {
  LearningProgressRepository,
  LearningProgressData,
  UpsertEventsResult,
} from '../../core/ports.js';
import type { LearningProgressEvent } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { LearningProgressEventRow } from '@/infra/database/user/types.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating the repository.
 */
export interface LearningProgressRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

class KyselyLearningProgressRepo implements LearningProgressRepository {
  private readonly db: UserDbClient;
  private readonly log: Logger;

  constructor(options: LearningProgressRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ module: 'learning-progress-repo' });
  }

  async getProgress(
    userId: string
  ): Promise<Result<LearningProgressData | null, LearningProgressError>> {
    try {
      const row = await this.db
        .selectFrom('learningprogress')
        .select(['events', 'last_event_at', 'event_count'])
        .where('user_id', '=', userId)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      // Parse JSONB events to domain types
      const events = this.mapRowEventsToEvents(row.events);

      return ok({
        events,
        lastEventAt: row.last_event_at !== null ? row.last_event_at.toISOString() : null,
        eventCount: row.event_count,
      });
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to get learning progress');
      return err(createDatabaseError('Failed to get learning progress', error));
    }
  }

  async upsertEvents(
    userId: string,
    events: LearningProgressEvent[]
  ): Promise<Result<UpsertEventsResult, LearningProgressError>> {
    if (events.length === 0) {
      return ok({ newEventsCount: 0, totalEventCount: 0 });
    }

    try {
      // Get existing progress (or create new)
      const existingResult = await this.getProgress(userId);
      if (existingResult.isErr()) {
        return err(existingResult.error);
      }

      const existingData = existingResult.value;
      const existingEvents = existingData?.events ?? [];

      // Merge events (deduplicates by eventId)
      const mergedEvents = mergeEvents(existingEvents, events);
      const newEventsCount = countNewEvents(existingEvents, events);

      // Find the latest event timestamp
      const latestEvent = mergedEvents.reduce<LearningProgressEvent | null>((latest, event) => {
        if (latest === null || event.occurredAt > latest.occurredAt) {
          return event;
        }
        return latest;
      }, null);

      const lastEventAt = latestEvent?.occurredAt ?? null;

      // Convert to row format
      const eventsJson = this.mapEventsToRowEvents(mergedEvents);

      if (existingData === null) {
        // Insert new row
        await this.db
          .insertInto('learningprogress')
          .values({
            user_id: userId,
            events: sql`${JSON.stringify(eventsJson)}::jsonb`,
            last_event_at: lastEventAt !== null ? new Date(lastEventAt) : null,
            event_count: mergedEvents.length,
          } as never)
          .execute();
      } else {
        // Update existing row
        await this.db
          .updateTable('learningprogress')
          .set({
            events: sql`${JSON.stringify(eventsJson)}::jsonb`,
            last_event_at: lastEventAt !== null ? new Date(lastEventAt) : null,
            event_count: mergedEvents.length,
            updated_at: new Date(),
          } as never)
          .where('user_id', '=', userId)
          .execute();
      }

      return ok({
        newEventsCount,
        totalEventCount: mergedEvents.length,
      });
    } catch (error) {
      this.log.error({ err: error, userId, eventCount: events.length }, 'Failed to upsert events');
      return err(createDatabaseError('Failed to upsert learning progress events', error));
    }
  }

  async getEventCount(userId: string): Promise<Result<number, LearningProgressError>> {
    try {
      const row = await this.db
        .selectFrom('learningprogress')
        .select(['event_count'])
        .where('user_id', '=', userId)
        .executeTakeFirst();

      return ok(row?.event_count ?? 0);
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to get event count');
      return err(createDatabaseError('Failed to get event count', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Maps database row events to domain events.
   */
  private mapRowEventsToEvents(rowEvents: LearningProgressEventRow[]): LearningProgressEvent[] {
    return rowEvents.map((row) => ({
      eventId: row.eventId,
      occurredAt: row.occurredAt,
      clientId: row.clientId,
      type: row.type,
      payload: row.payload,
    })) as LearningProgressEvent[];
  }

  /**
   * Maps domain events to database row format.
   */
  private mapEventsToRowEvents(events: LearningProgressEvent[]): LearningProgressEventRow[] {
    return events.map((event) => ({
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      clientId: event.clientId,
      type: event.type,
      payload: 'payload' in event ? (event.payload as Record<string, unknown>) : {},
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a learning progress repository.
 */
export const makeLearningProgressRepo = (
  options: LearningProgressRepoOptions
): LearningProgressRepository => {
  return new KyselyLearningProgressRepo(options);
};
