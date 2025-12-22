/**
 * Learning Progress Module - Public API
 *
 * Exports for learning progress sync functionality.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  LearningProgressEvent,
  LearningProgressEventType,
  LearningProgressEventBase,
  ContentProgressedEvent,
  OnboardingCompletedEvent,
  OnboardingResetEvent,
  ActivePathSetEvent,
  ProgressResetEvent,
  ContentProgressPayload,
  LearningContentStatus,
  LearningInteractionState,
  LearningProgressSnapshot,
  LearningContentProgress,
  LearningStreak,
  GetProgressResponse,
  SyncEventsRequest,
} from './core/types.js';

export {
  MAX_EVENTS_PER_REQUEST,
  MAX_EVENTS_PER_USER,
  SNAPSHOT_VERSION,
  STATUS_PRECEDENCE,
  isContentProgressedEvent,
  isOnboardingCompletedEvent,
  isOnboardingResetEvent,
  isActivePathSetEvent,
  isProgressResetEvent,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Errors
// ─────────────────────────────────────────────────────────────────────────────

export type {
  LearningProgressError,
  DatabaseError,
  TooManyEventsError,
  EventLimitExceededError,
  InvalidEventError,
} from './core/errors.js';

export {
  createDatabaseError,
  createTooManyEventsError,
  createEventLimitExceededError,
  createInvalidEventError,
  getHttpStatusForError,
  LEARNING_PROGRESS_ERROR_HTTP_STATUS,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Ports
// ─────────────────────────────────────────────────────────────────────────────

export type {
  LearningProgressRepository,
  LearningProgressData,
  UpsertEventsResult,
} from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Reducer (Pure Functions)
// ─────────────────────────────────────────────────────────────────────────────

export {
  reduceEventsToSnapshot,
  filterEventsSinceCursor,
  mergeEvents,
  countNewEvents,
  createEmptySnapshot,
} from './core/reducer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export {
  getProgress,
  type GetProgressDeps,
  type GetProgressInput,
} from './core/usecases/get-progress.js';

export {
  syncEvents,
  type SyncEventsDeps,
  type SyncEventsInput,
  type SyncEventsOutput,
} from './core/usecases/sync-events.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Repository
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeLearningProgressRepo,
  type LearningProgressRepoOptions,
} from './shell/repo/learning-progress-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST Routes
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeLearningProgressRoutes,
  type MakeLearningProgressRoutesDeps,
} from './shell/rest/routes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST Schemas
// ─────────────────────────────────────────────────────────────────────────────

export {
  GetProgressQuerySchema,
  SyncEventsBodySchema,
  GetProgressResponseSchema,
  SyncEventsResponseSchema,
  ErrorResponseSchema,
  LearningProgressEventSchema,
  type GetProgressQuery,
  type SyncEventsBody,
} from './shell/rest/schemas.js';
