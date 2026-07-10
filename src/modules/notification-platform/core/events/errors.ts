import type {
  DatabaseError,
  NotFoundError,
  QueueError,
  ValidationError,
} from '../shared/errors.js';

export interface EventPayloadConflictError {
  type: 'EventPayloadConflict';
  eventId: string;
  occurrenceKey: string;
}

export interface EventSourceError {
  type: 'EventSourceError';
  sourceId: string;
  message: string;
  retryable: boolean;
}

export type EventError =
  | DatabaseError
  | ValidationError
  | QueueError
  | NotFoundError
  | EventPayloadConflictError;

export const createEventPayloadConflictError = (
  eventId: string,
  occurrenceKey: string
): EventPayloadConflictError => ({
  type: 'EventPayloadConflict',
  eventId,
  occurrenceKey,
});

export const createEventSourceError = (
  sourceId: string,
  message: string,
  retryable = true
): EventSourceError => ({
  type: 'EventSourceError',
  sourceId,
  message,
  retryable,
});
