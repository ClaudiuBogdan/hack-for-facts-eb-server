/**
 * Learning Progress Module - Domain Types
 *
 * The server stores one row per user and per client-controlled record key.
 * It treats all synced state as generic interactive records.
 */

export const MAX_EVENTS_PER_REQUEST = 100;
export const SNAPSHOT_VERSION = 1;

export type LessonId = string;

export type InteractionScope =
  | { readonly type: 'global' }
  | { readonly type: 'entity'; readonly entityCui: string };

export type InteractionValue =
  | { readonly kind: 'choice'; readonly choice: { readonly selectedId: string | null } }
  | { readonly kind: 'text'; readonly text: { readonly value: string } }
  | { readonly kind: 'url'; readonly url: { readonly value: string } }
  | { readonly kind: 'number'; readonly number: { readonly value: number | null } }
  | { readonly kind: 'json'; readonly json: { readonly value: Readonly<Record<string, unknown>> } };

export type InteractionPhase = 'idle' | 'draft' | 'pending' | 'resolved' | 'error';

export type InteractionOutcome = 'correct' | 'incorrect' | null;

export interface InteractionResult {
  readonly outcome: InteractionOutcome;
  readonly score?: number | null;
  readonly feedbackText?: string | null;
  readonly response?: Readonly<Record<string, unknown>> | null;
  readonly evaluatedAt?: string | null;
}

export type InteractiveDefinitionKind = 'quiz' | 'url' | 'text-input' | 'custom';

export type InteractionCompletionRule =
  | { readonly type: 'outcome'; readonly outcome: Exclude<InteractionOutcome, null> }
  | { readonly type: 'resolved' }
  | { readonly type: 'score-threshold'; readonly minScore: number }
  | { readonly type: 'component-flag'; readonly flag: string };

export interface InteractiveStateRecord {
  readonly key: string;
  readonly interactionId: string;
  readonly lessonId: LessonId;
  readonly kind: InteractiveDefinitionKind;
  readonly scope: InteractionScope;
  readonly completionRule: InteractionCompletionRule;
  readonly phase: InteractionPhase;
  readonly value: InteractionValue | null;
  readonly result: InteractionResult | null;
  readonly updatedAt: string;
  readonly submittedAt?: string | null;
}

export type InteractiveAuditEvent =
  | {
      readonly id: string;
      readonly recordKey: string;
      readonly lessonId: LessonId;
      readonly interactionId: string;
      readonly type: 'submitted';
      readonly at: string;
      readonly actor: 'user';
      readonly value: InteractionValue;
    }
  | {
      readonly id: string;
      readonly recordKey: string;
      readonly lessonId: LessonId;
      readonly interactionId: string;
      readonly type: 'evaluated';
      readonly at: string;
      readonly actor: 'system';
      readonly phase: 'resolved' | 'error';
      readonly result: InteractionResult;
    };

export type StoredInteractiveAuditEvent = InteractiveAuditEvent & {
  readonly seq: string;
  readonly sourceClientEventId: string;
  readonly sourceClientId: string;
};

export interface LearningProgressSnapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly recordsByKey: Readonly<Record<string, InteractiveStateRecord>>;
  readonly lastUpdated: string | null;
}

export type LearningProgressEventType = 'interactive.updated' | 'progress.reset';

export interface LearningProgressEventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly clientId: string;
  readonly type: LearningProgressEventType;
}

export type LearningInteractiveUpdatedEvent = LearningProgressEventBase & {
  readonly type: 'interactive.updated';
  readonly payload: {
    readonly record: InteractiveStateRecord;
    readonly auditEvents?: readonly InteractiveAuditEvent[];
  };
};

export type LearningProgressResetEvent = LearningProgressEventBase & {
  readonly type: 'progress.reset';
};

export type LearningProgressEvent = LearningInteractiveUpdatedEvent | LearningProgressResetEvent;

export interface GetProgressResponse {
  readonly snapshot: LearningProgressSnapshot;
  readonly events: readonly LearningInteractiveUpdatedEvent[];
  readonly cursor: string;
}

export interface SyncEventsRequest {
  readonly clientUpdatedAt: string;
  readonly events: readonly LearningProgressEvent[];
}

export interface LearningProgressRecordRow {
  readonly userId: string;
  readonly recordKey: string;
  readonly record: InteractiveStateRecord;
  readonly auditEvents: readonly StoredInteractiveAuditEvent[];
  readonly updatedSeq: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertInteractiveRecordInput {
  readonly userId: string;
  readonly eventId: string;
  readonly clientId: string;
  readonly occurredAt: string;
  readonly record: InteractiveStateRecord;
  readonly auditEvents: readonly InteractiveAuditEvent[];
}

export interface UpsertInteractiveRecordResult {
  readonly applied: boolean;
  readonly row: LearningProgressRecordRow;
}

export const isInteractiveUpdatedEvent = (
  event: LearningProgressEvent
): event is LearningInteractiveUpdatedEvent => {
  return event.type === 'interactive.updated';
};

export const isProgressResetEvent = (
  event: LearningProgressEvent
): event is LearningProgressResetEvent => {
  return event.type === 'progress.reset';
};
