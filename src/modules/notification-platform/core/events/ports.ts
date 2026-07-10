import type { EventError, EventSourceError } from './errors.js';
import type { EventFanOutJobPayload } from './schemas.js';
import type { CreateNotificationEventInput, NotificationEvent, SourceOccurrence } from './types.js';
import type { QueueError } from '../shared/errors.js';
import type { Result } from 'neverthrow';

export interface NotificationEventRepo {
  insertOrFind(
    input: CreateNotificationEventInput & {
      id: string;
      payloadHash: string;
      streamKey: string | null;
      streamSequence: number | null;
      retentionExpiresAt: Date;
    }
  ): Promise<
    Result<{ event: NotificationEvent; created: boolean; payloadConflict: boolean }, EventError>
  >;
  findById(eventId: string): Promise<Result<NotificationEvent | null, EventError>>;
  claimForResolution(input: {
    eventId: string;
    claimToken: string;
    leaseSeconds: number;
    now: Date;
  }): Promise<Result<NotificationEvent | null, EventError>>;
  saveResolutionCursor(input: {
    eventId: string;
    cursor: string;
    expectedClaimToken: string;
  }): Promise<Result<boolean, EventError>>;
  markResolved(input: {
    eventId: string;
    expectedClaimToken: string;
    now: Date;
  }): Promise<Result<boolean, EventError>>;
  markConflicted(eventId: string): Promise<Result<void, EventError>>;
  findUnresolvedOlderThan(input: {
    olderThan: Date;
    limit: number;
  }): Promise<Result<NotificationEvent[], EventError>>;
}

export interface SourceWatermarkRepo {
  get(sourceId: string): Promise<Result<string | null, EventError>>;
  compareAndSet(input: {
    sourceId: string;
    expected: string | null;
    next: string;
  }): Promise<Result<boolean, EventError>>;
}

export interface EventSourcePort {
  readonly sourceId: string;
  readOccurrences(input: {
    watermark: string | null;
    limit: number;
  }): Promise<
    Result<{ occurrences: SourceOccurrence[]; nextWatermark: string | null }, EventSourceError>
  >;
}

export interface EventFanOutScheduler {
  enqueue(payload: EventFanOutJobPayload): Promise<Result<void, QueueError>>;
}
