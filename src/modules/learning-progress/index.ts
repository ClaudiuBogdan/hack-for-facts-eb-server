/**
 * Learning Progress Module - Public API
 */

export type {
  LessonId,
  InteractionScope,
  InteractionValue,
  InteractionPhase,
  InteractionOutcome,
  InteractionResult,
  InteractiveDefinitionKind,
  InteractionCompletionRule,
  InteractiveStateRecord,
  InteractiveAuditEvent,
  StoredInteractiveAuditEvent,
  LearningProgressSnapshot,
  LearningProgressEventType,
  LearningProgressEventBase,
  LearningInteractiveUpdatedEvent,
  LearningProgressResetEvent,
  LearningProgressEvent,
  GetProgressResponse,
  SyncEventsRequest,
  LearningProgressRecordRow,
  UpsertInteractiveRecordInput,
  UpsertInteractiveRecordResult,
} from './core/types.js';

export {
  MAX_EVENTS_PER_REQUEST,
  SNAPSHOT_VERSION,
  isInteractiveUpdatedEvent,
  isProgressResetEvent,
} from './core/types.js';

export type {
  LearningProgressError,
  DatabaseError,
  TooManyEventsError,
  InvalidEventError,
} from './core/errors.js';

export {
  createDatabaseError,
  createTooManyEventsError,
  createInvalidEventError,
  getHttpStatusForError,
  LEARNING_PROGRESS_ERROR_HTTP_STATUS,
} from './core/errors.js';

export type { LearningProgressRepository } from './core/ports.js';

export {
  createEmptySnapshot,
  buildSnapshotFromRecords,
  buildDeltaEventsFromRecords,
  getLatestCursor,
} from './core/reducer.js';

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

export {
  makeLearningProgressRepo,
  type LearningProgressRepoOptions,
} from './shell/repo/learning-progress-repo.js';

export {
  makeLearningProgressRoutes,
  type MakeLearningProgressRoutesDeps,
} from './shell/rest/routes.js';

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
