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
  InteractionReviewStatus,
  ReviewDecisionStatus,
  InteractionReview,
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
  ReviewDecision,
  GetRecordsOptions,
  ListReviewRowsInput,
  ListReviewRowsOutput,
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
  NotFoundError,
  ConflictError,
} from './core/errors.js';

export {
  createDatabaseError,
  createTooManyEventsError,
  createInvalidEventError,
  createNotFoundError,
  createConflictError,
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

export { validateRecordKeyPrefix } from './core/namespace.js';

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
  listInteractionReviews,
  type ListInteractionReviewsDeps,
  type ListInteractionReviewsInput,
  type ListInteractionReviewsOutput,
} from './core/usecases/list-interaction-reviews.js';

export {
  submitInteractionReviews,
  type SubmitInteractionReviewsDeps,
  type SubmitInteractionReviewsInput,
  type SubmitInteractionReviewsOutput,
} from './core/usecases/submit-interaction-reviews.js';

export {
  updateInteractionReview,
  type UpdateInteractionReviewDeps,
  type UpdateInteractionReviewInput,
  type UpdateInteractionReviewOutput,
} from './core/usecases/update-interaction-review.js';

export {
  makeLearningProgressRepo,
  type LearningProgressRepoOptions,
} from './shell/repo/learning-progress-repo.js';

export {
  makeLearningProgressRoutes,
  type MakeLearningProgressRoutesDeps,
} from './shell/rest/routes.js';

export {
  makeLearningProgressAdminReviewRoutes,
  type MakeLearningProgressAdminReviewRoutesDeps,
} from './shell/rest/admin-routes.js';

export {
  GetProgressQuerySchema,
  SyncEventsBodySchema,
  GetProgressResponseSchema,
  SyncEventsResponseSchema,
  ErrorResponseSchema,
  LearningProgressEventSchema,
  InteractionValueSchema,
  InteractionResultSchema,
  InteractionReviewSchema,
  InteractionScopeSchema,
  InteractionCompletionRuleSchema,
  InteractiveStateRecordSchema,
  InteractiveAuditEventSchema,
  type GetProgressQuery,
  type SyncEventsBody,
} from './shell/rest/schemas.js';

export {
  LEARNING_PROGRESS_REVIEW_API_KEY_HEADER,
  makeLearningProgressAdminReviewAuthHook,
  type LearningProgressAdminReviewAuthConfig,
} from './shell/rest/admin-auth.js';

export {
  ReviewQueueQuerySchema,
  SubmitInteractionReviewsBodySchema,
  ReviewQueueResponseSchema,
  SubmitInteractionReviewsResponseSchema,
  LearningProgressRecordRowSchema,
  StoredInteractiveAuditEventSchema,
  type ReviewQueueQuery,
  type ReviewDecisionBody,
  type SubmitInteractionReviewsBody,
} from './shell/rest/admin-schemas.js';
