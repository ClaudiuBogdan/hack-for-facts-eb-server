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
  InteractionReviewSource,
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
  ReviewSideEffectPlan,
  ApprovedReviewSideEffectPlan,
  PrepareReviewSideEffectsInput,
  ReviewActorMetadata,
  GetRecordsOptions,
  CampaignAdminCampaignKey,
  CampaignAdminSortOrder,
  CampaignAdminSubmissionPath,
  CampaignAdminInteractionFilter,
  CampaignAdminInstitutionThreadPhase,
  CampaignAdminListCursor,
  CampaignAdminUserSortBy,
  CampaignAdminUserListCursor,
  CampaignAdminInstitutionThreadSummary,
  CampaignAdminInteractionRow,
  CampaignAdminUserRow,
  CampaignAdminUsersMetaCounts,
  CampaignAdminReviewStatusCounts,
  CampaignAdminPhaseCounts,
  CampaignAdminThreadPhaseCounts,
  CampaignAdminStats,
  CampaignAdminStatsBase,
  CampaignAdminRiskFlagCandidate,
  ListCampaignAdminInteractionRowsInput,
  ListCampaignAdminInteractionRowsOutput,
  ListCampaignAdminUsersInput,
  ListCampaignAdminUsersOutput,
  GetCampaignAdminUsersMetaCountsInput,
  GetCampaignAdminStatsInput,
  GetCampaignAdminStatsOutput,
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
  INTERNAL_NAMESPACE_PREFIX,
  INTERNAL_FUNKY_WEEKLY_DIGEST_KEY,
  INTERNAL_FUNKY_WEEKLY_DIGEST_INTERACTION_ID,
  isInternalRecordKey,
  isInternalInteractionId,
} from './core/internal-records.js';

export {
  buildCampaignAdminInteractionStepLink,
  buildCampaignProvocariStepPath,
  extractInteractionEntityCui,
} from './core/campaign-admin-step-links.js';

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
  WeeklyDigestCursorPayloadSchema,
  getWeeklyDigestCursor,
  upsertWeeklyDigestCursor,
  type WeeklyDigestCursorPayload,
} from './core/usecases/weekly-digest-cursor.js';

export {
  REVIEWED_INTERACTION_SOURCE_INTERACTION_IDS,
  hasStartedLatestEntityInteraction,
  listReviewedInteractionCandidates,
  loadLatestEntityInteractionRow,
  loadReviewedInteractionCandidateByIdentity,
  type ReviewedInteractionCandidateIdentity,
  type ListReviewedInteractionCandidatesInput,
  type LoadLatestEntityInteractionRowInput,
} from './core/usecases/reviewed-interaction-source.js';
export {
  autoResolvePendingInteractionFromReviewedMatch,
  type AutoResolvePendingInteractionFromReviewedMatchDeps,
  type AutoResolvePendingInteractionFromReviewedMatchInput,
  type AutoResolvePendingInteractionFromReviewedMatchOutput,
  type AutoReviewReuseSkipReason,
} from './core/usecases/auto-resolve-pending-interaction-from-reviewed-match.js';
export {
  reconcileAutoReviewReuse,
  type ReconcileAutoReviewReuseDeps,
  type ReconcileAutoReviewReuseInput,
  type ReconcileAutoReviewReuseSummary,
} from './core/usecases/reconcile-auto-review-reuse.js';

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
  makeCampaignAdminUserInteractionRoutes,
  type MakeCampaignAdminUserInteractionRoutesDeps,
} from './shell/rest/campaign-admin-routes.js';

export type {
  CampaignReviewProjectionKind,
  CampaignInteractionStepLocation,
  CampaignAdminInteractionConfig,
  CampaignAuditConfig,
  CampaignAdminAvailableInteractionType,
} from './core/campaign-admin-config.js';

export {
  CAMPAIGN_ADMIN_REVIEW_CAMPAIGN_KEYS,
  buildCampaignAutoReviewReuseFilters,
  getCampaignAdminReviewConfig,
  getCampaignAdminInteractionConfig,
  selectCampaignAdminAuditVisibleInteractions,
  buildCampaignInteractionFilters,
  listCampaignAdminAvailableInteractionTypes,
} from './core/campaign-admin-config.js';

export {
  type CampaignAdminPermissionAuthorizer,
  makeClerkCampaignAdminPermissionAuthorizer,
  type ClerkCampaignAdminPermissionAuthorizerOptions,
} from '@/modules/campaign-admin/index.js';

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
  CampaignKeyParamsSchema,
  CampaignAdminCursorSchema,
  CampaignAdminListQuerySchema,
  CampaignAdminUserCursorSchema,
  CampaignAdminUserListQuerySchema,
  CampaignAdminAvailableInteractionTypeSchema,
  CampaignAdminReviewStatusCountsSchema,
  CampaignAdminPhaseCountsSchema,
  CampaignAdminThreadPhaseCountsSchema,
  CampaignAdminStatsSchema,
  CampaignAdminInteractionListItemSchema,
  CampaignAdminMetaResponseSchema,
  CampaignAdminListResponseSchema,
  CampaignAdminUserListItemSchema,
  CampaignAdminUsersMetaResponseSchema,
  CampaignAdminUserListResponseSchema,
  CampaignAdminReviewDecisionSchema,
  CampaignAdminSubmitReviewsBodySchema,
  CampaignAdminSubmitReviewsResponseSchema,
  type CampaignKeyParams,
  type CampaignAdminListQuery,
  type CampaignAdminUserCursor,
  type CampaignAdminUserListQuery,
  type CampaignAdminReviewDecisionBody,
  type CampaignAdminSubmitReviewsBody,
} from './shell/rest/campaign-admin-schemas.js';
