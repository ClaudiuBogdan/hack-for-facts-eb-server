/**
 * Learning Progress Module - Domain Types
 *
 * Types for event-sourced learning progress sync.
 * Matches the client specification for LearningProgressEvent and LearningProgressSnapshot.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum events allowed per PUT request */
export const MAX_EVENTS_PER_REQUEST = 100;

/** Maximum total events stored per user */
export const MAX_EVENTS_PER_USER = 10_000;

/** Snapshot version for forward compatibility */
export const SNAPSHOT_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported event types for learning progress.
 */
export type LearningProgressEventType =
  | 'content.progressed'
  | 'onboarding.completed'
  | 'onboarding.reset'
  | 'activePath.set'
  | 'progress.reset';

/**
 * Content status progression.
 * Status precedence (highest to lowest): passed > completed > in_progress > not_started
 */
export type LearningContentStatus = 'not_started' | 'in_progress' | 'completed' | 'passed';

/**
 * Status precedence map for conflict resolution.
 * Higher number = higher precedence.
 */
export const STATUS_PRECEDENCE: Record<LearningContentStatus, number> = {
  not_started: 0,
  in_progress: 1,
  completed: 2,
  passed: 3,
};

/**
 * Interaction state for quizzes and interactive content.
 * The exact structure depends on interaction type (quiz, drag-drop, etc).
 */
export type LearningInteractionState = Record<string, unknown>;

/**
 * Base fields for all learning progress events.
 */
export interface LearningProgressEventBase {
  /** Unique event identifier (client-generated UUID) */
  eventId: string;
  /** When the event occurred (ISO 8601 timestamp) */
  occurredAt: string;
  /** Client/device identifier */
  clientId: string;
  /** Event type discriminator */
  type: LearningProgressEventType;
}

/**
 * Payload for content.progressed events.
 */
export interface ContentProgressPayload {
  /** Unique content identifier */
  contentId: string;
  /** New status for the content */
  status: LearningContentStatus;
  /** Optional score (0-100) for assessments */
  score?: number;
  /** Content version for tracking changes */
  contentVersion?: string;
  /** Optional interaction state update */
  interaction?: {
    /** Unique interaction identifier */
    interactionId: string;
    /** Interaction state (null to clear/reset) */
    state: LearningInteractionState | null;
  };
}

/**
 * Event: User progressed on content (lesson, quiz, etc).
 */
export interface ContentProgressedEvent extends LearningProgressEventBase {
  type: 'content.progressed';
  payload: ContentProgressPayload;
}

/**
 * Event: User completed onboarding with a specific path.
 */
export interface OnboardingCompletedEvent extends LearningProgressEventBase {
  type: 'onboarding.completed';
  payload: {
    /** The path selected during onboarding */
    pathId: string;
  };
}

/**
 * Event: User reset their onboarding state.
 * Note: This event has NO payload field per client specification.
 */
export interface OnboardingResetEvent extends LearningProgressEventBase {
  type: 'onboarding.reset';
}

/**
 * Event: User changed their active learning path.
 */
export interface ActivePathSetEvent extends LearningProgressEventBase {
  type: 'activePath.set';
  payload: {
    /** The new active path (null to clear) */
    pathId: string | null;
  };
}

/**
 * Event: User reset all their learning progress.
 * Note: This event has NO payload field.
 */
export interface ProgressResetEvent extends LearningProgressEventBase {
  type: 'progress.reset';
}

/**
 * Union of all learning progress event types.
 */
export type LearningProgressEvent =
  | ContentProgressedEvent
  | OnboardingCompletedEvent
  | OnboardingResetEvent
  | ActivePathSetEvent
  | ProgressResetEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot Types (Derived State)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Progress state for a single content item.
 */
export interface LearningContentProgress {
  /** Content identifier */
  contentId: string;
  /** Current status */
  status: LearningContentStatus;
  /** Best score achieved (if applicable) */
  score?: number;
  /** When the content was first completed/passed */
  completedAt?: string;
  /** When the content was last attempted */
  lastAttemptAt?: string;
  /** Interaction states keyed by interactionId */
  interactions: Record<string, LearningInteractionState | null>;
}

/**
 * Learning streak information.
 */
export interface LearningStreak {
  /** Current consecutive days streak */
  currentStreak: number;
  /** Longest streak ever achieved */
  longestStreak: number;
  /** Date of last activity (YYYY-MM-DD) */
  lastActivityDate: string | null;
}

/**
 * Complete learning progress snapshot.
 * This is derived from the event log and represents the current state.
 */
export interface LearningProgressSnapshot {
  /** Schema version for forward compatibility */
  version: number;
  /** Currently active learning path (null if none) */
  activePath: string | null;
  /** When onboarding was completed (ISO timestamp) */
  onboardingCompletedAt: string | null;
  /** Path selected during onboarding */
  onboardingPathId: string | null;
  /** Content progress keyed by contentId */
  content: Record<string, LearningContentProgress>;
  /** Streak information */
  streak: LearningStreak;
  /** When progress was last updated (max occurredAt from events) */
  lastUpdated: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Response data for GET /progress endpoint.
 * Client derives snapshot from events.
 */
export interface GetProgressResponse {
  /** All events (or events since cursor if provided) */
  events: LearningProgressEvent[];
  /** Cursor for subsequent sync requests (ISO timestamp of latest event) */
  cursor: string;
}

/**
 * Request body for PUT /progress endpoint.
 */
export interface SyncEventsRequest {
  /** Client's timestamp when sync was initiated */
  clientUpdatedAt: string;
  /** Events to sync (max 100) */
  events: LearningProgressEvent[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an event is a content.progressed event.
 */
export const isContentProgressedEvent = (
  event: LearningProgressEvent
): event is ContentProgressedEvent => {
  return event.type === 'content.progressed';
};

/**
 * Check if an event is an onboarding.completed event.
 */
export const isOnboardingCompletedEvent = (
  event: LearningProgressEvent
): event is OnboardingCompletedEvent => {
  return event.type === 'onboarding.completed';
};

/**
 * Check if an event is an onboarding.reset event.
 */
export const isOnboardingResetEvent = (
  event: LearningProgressEvent
): event is OnboardingResetEvent => {
  return event.type === 'onboarding.reset';
};

/**
 * Check if an event is an activePath.set event.
 */
export const isActivePathSetEvent = (event: LearningProgressEvent): event is ActivePathSetEvent => {
  return event.type === 'activePath.set';
};

/**
 * Check if an event is a progress.reset event.
 */
export const isProgressResetEvent = (event: LearningProgressEvent): event is ProgressResetEvent => {
  return event.type === 'progress.reset';
};
