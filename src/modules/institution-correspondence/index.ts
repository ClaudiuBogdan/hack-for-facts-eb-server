export type {
  AdminResponseEvent,
  AdminWorkflow,
  CampaignAdminThreadListCursor,
  CampaignAdminThreadState,
  CampaignAdminThreadStateGroup,
  CampaignAdminResponseStatus,
  CampaignAdminThreadPage,
  ListCampaignAdminThreadsInput,
  CampaignAdminThreadLookupInput,
  AppendCampaignAdminThreadResponseInput,
  AppendCampaignAdminThreadResponseOutput,
  InstitutionRequestType,
  SubmissionPath,
  ThreadPhase,
  ResolutionCode,
  MessageDirection,
  MessageSource,
  CorrespondenceAttachmentMetadata,
  CorrespondenceEntry,
  ThreadReview,
  CorrespondenceThreadRecord,
  ThreadRecord,
  ReceivedEmailSnapshot,
  SendPlatformRequestInput,
  SendPlatformRequestOutput,
  PendingReplyItem,
  PendingReplyPage,
  ListPendingRepliesInput,
  ReviewReplyInput,
  ReviewReplyOutput,
  UnmatchedInboundMetadata,
} from './core/types.js';

export {
  PUBLIC_DEBATE_REQUEST_TYPE,
  FUNKY_CITIZENS_NGO_IDENTITY,
  RESOLUTION_TO_PHASE,
  REVIEWABLE_PHASE,
  SubmissionPathSchema,
  ThreadPhaseSchema,
  CampaignAdminThreadStateSchema,
  CampaignAdminThreadStateGroupSchema,
  CampaignAdminResponseStatusSchema,
  ResolutionCodeSchema,
  MessageDirectionSchema,
  MessageSourceSchema,
  CorrespondenceAttachmentMetadataSchema,
  CorrespondenceEntrySchema,
  ThreadReviewSchema,
  AdminResponseEventSchema,
  AdminWorkflowSchema,
  CorrespondenceThreadRecordSchema,
} from './core/types.js';

export {
  appendAdminResponseEvent,
  deriveCampaignAdminThreadStateFromLowLevelPhase,
  deriveCampaignAdminThreadStateFromResponseStatus,
  getLatestAdminResponseEvent,
  isCampaignAdminThreadInScope,
  projectCampaignAdminThread,
  readAdminResponseEvents,
  readAdminWorkflow,
  type CampaignAdminThreadProjection,
} from './core/admin-workflow.js';

export type {
  InstitutionCorrespondenceError,
  CorrespondenceDatabaseError,
  CorrespondenceValidationError,
  CorrespondenceConflictError,
  CorrespondenceNotFoundError,
  CorrespondenceEmailSendError,
} from './core/errors.js';

export {
  createDatabaseError,
  createValidationError,
  createConflictError,
  createNotFoundError,
  createEmailSendError,
  getHttpStatusForError,
} from './core/errors.js';

export type {
  InstitutionCorrespondenceRepository,
  CreateThreadInput,
  UpdateThreadInput,
  AppendCorrespondenceEntryInput,
  LockedThreadMutation,
  PublicDebateEntitySubscriptionService,
  PublicDebateEntityUpdatePublishStatus,
  PublicDebateEntityUpdatePublishResult,
  PublicDebateEntityUpdateNotification,
  PublicDebateEntityUpdatePublisher,
  InstitutionOfficialEmailLookup,
  MessageReferenceThreadLookup,
  PublicDebateSelfSendContext,
  PublicDebateSelfSendContextMatch,
  PublicDebateSelfSendContextLookup,
  PublicDebateSelfSendApprovalService,
  CorrespondenceTemplateRenderer,
  CorrespondenceEmailSender,
  CorrespondenceReceivedEmailFetcher,
} from './core/ports.js';

export {
  deriveCurrentPlatformSendSnapshot,
  type DerivedCurrentPlatformSendSnapshotResult,
} from './core/usecases/derive-current-platform-send-snapshot.js';
export {
  publishCurrentPlatformSendUpdate,
  type PublishCurrentPlatformSendUpdateDeps,
  type PublishCurrentPlatformSendUpdateInput,
  type PublishCurrentPlatformSendUpdateResult,
} from './core/usecases/publish-current-platform-send-update.js';
export {
  recoverMissingPublicDebateSnapshots,
  type RecoverMissingPublicDebateSnapshotsDeps,
  type RecoverMissingPublicDebateSnapshotsResult,
} from './core/usecases/recover-missing-public-debate-snapshots.js';
export {
  sendPlatformRequest,
  type SendPlatformRequestDeps,
} from './core/usecases/send-platform-request.js';
export {
  requestPublicDebatePlatformSend,
  type RequestPublicDebatePlatformSendDeps,
} from './core/usecases/request-public-debate-platform-send.js';
export {
  reconcilePlatformSendSuccess,
  type ReconcilePlatformSendSuccessDeps,
  type ReconcilePlatformSendSuccessInput,
  type ReconcilePlatformSendSuccessResult,
} from './core/usecases/reconcile-platform-send-success.js';
export {
  recoverPlatformSendSuccessConfirmation,
  type PlatformSendSuccessEvidenceLookup,
  type RecoverPlatformSendSuccessConfirmationDeps,
  type RecoverPlatformSendSuccessConfirmationInput,
  type RecoverPlatformSendSuccessConfirmationResult,
} from './core/usecases/recover-platform-send-success-confirmation.js';
export {
  listPendingReplies,
  type ListPendingRepliesDeps,
} from './core/usecases/list-pending-replies.js';
export { reviewReply, type ReviewReplyDeps } from './core/usecases/review-reply.js';
export { getThread, type GetThreadDeps } from './core/usecases/get-thread.js';
export {
  listCampaignAdminThreads,
  type ListCampaignAdminThreadsDeps,
} from './core/usecases/list-campaign-admin-threads.js';
export {
  getCampaignAdminThread,
  type GetCampaignAdminThreadDeps,
} from './core/usecases/get-campaign-admin-thread.js';
export {
  appendCampaignAdminThreadResponse,
  type AppendCampaignAdminThreadResponseDeps,
} from './core/usecases/append-campaign-admin-thread-response.js';

export {
  EMAIL_REGEX,
  DEFAULT_NGO_IDENTITY,
  DEFAULT_REQUEST_TYPE,
  SUBJECT_THREAD_KEY_PREFIX,
  normalizeOptionalString,
  normalizeEmailAddress,
  normalizeEmailSubject,
  buildPublicDebateRequestSubject,
  buildSelfSendInteractionKey,
  parseOptionalDate,
  computeContestationDeadline,
  encodeThreadKeyForTag,
  decodeThreadKeyFromTag,
  buildSharedCorrespondenceInboxAddress,
  embedThreadKeyInSubject,
  extractThreadKeyFromSubject,
  extractMessageReferences,
} from './core/usecases/helpers.js';
export {
  PlatformSendThreadMetadataPatchSchema,
  PlatformSendThreadMetadataSchema,
  readPlatformSendThreadMetadata,
  writePlatformSendThreadMetadata,
  type PlatformSendThreadMetadata,
  type PlatformSendThreadMetadataPatch,
} from './core/platform-send-thread-metadata.js';
export {
  buildReconcilePlatformSendSuccessInputFromThread,
  hasPlatformSendSuccessConfirmation,
  markPlatformSendSuccessConfirmed,
  readPlatformSendSuccessMetadata,
  withPlatformSendAttemptMetadata,
  withPlatformSendSuccessMetadata,
  type PlatformSendSuccessConfirmationState,
  type PlatformSendSuccessMetadata,
} from './core/usecases/platform-send-success-confirmation.js';

export {
  makeInstitutionCorrespondenceRepo,
  type InstitutionCorrespondenceRepoConfig,
} from './shell/repo/institution-correspondence-repo.js';

export {
  makeOfficialEmailLookup,
  type OfficialEmailLookupConfig,
} from './shell/repo/official-email-lookup.js';
export {
  makePlatformSendSuccessEvidenceLookup,
  type PlatformSendSuccessEvidenceLookupConfig,
} from './shell/repo/platform-send-success-evidence-lookup.js';

export { makePublicDebateTemplateRenderer } from './shell/templates/public-debate-request.js';
export {
  makePublicDebateNotificationOrchestrator,
  type MakePublicDebateNotificationOrchestratorDeps,
  type PublicDebateNotificationOrchestrator,
} from './shell/public-debate-notification-orchestrator.js';

export {
  makeCampaignAdminInstitutionThreadRoutes,
  type MakeCampaignAdminInstitutionThreadRoutesDeps,
} from './shell/rest/campaign-admin-routes.js';

export {
  makeInstitutionCorrespondenceResendSideEffect,
  type InstitutionCorrespondenceResendSideEffectDeps,
} from './shell/webhook/resend-side-effect.js';
export {
  startCorrespondenceRecoveryRuntime,
  type CorrespondenceRecoveryRuntime,
  type CorrespondenceRecoveryRuntimeConfig,
  type CorrespondenceRecoveryRuntimeFactory,
} from './shell/queue/recovery-runtime.js';
