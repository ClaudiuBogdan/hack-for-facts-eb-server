export type {
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
  PrepareSelfSendInput,
  PrepareSelfSendOutput,
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
  CorrespondenceEntrySchema,
  ThreadReviewSchema,
  CorrespondenceThreadRecordSchema,
} from './core/types.js';

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
  InstitutionOfficialEmailLookup,
  MessageReferenceThreadLookup,
  PublicDebateSelfSendContext,
  PublicDebateSelfSendContextLookup,
  CorrespondenceTemplateRenderer,
  CorrespondenceEmailSender,
  CorrespondenceReceivedEmailFetcher,
} from './core/ports.js';

export { prepareSelfSend, type PrepareSelfSendDeps } from './core/usecases/prepare-self-send.js';
export {
  sendPlatformRequest,
  type SendPlatformRequestDeps,
} from './core/usecases/send-platform-request.js';
export {
  listPendingReplies,
  type ListPendingRepliesDeps,
} from './core/usecases/list-pending-replies.js';
export { reviewReply, type ReviewReplyDeps } from './core/usecases/review-reply.js';
export { getThread, type GetThreadDeps } from './core/usecases/get-thread.js';

export {
  EMAIL_REGEX,
  DEFAULT_NGO_IDENTITY,
  DEFAULT_REQUEST_TYPE,
  SUBJECT_THREAD_KEY_PREFIX,
  normalizeOptionalString,
  normalizeEmailAddress,
  parseOptionalDate,
  computeContestationDeadline,
  buildSharedCorrespondenceInboxAddress,
  embedThreadKeyInSubject,
  extractThreadKeyFromSubject,
  extractMessageReferences,
} from './core/usecases/helpers.js';

export {
  makeInstitutionCorrespondenceRepo,
  type InstitutionCorrespondenceRepoConfig,
} from './shell/repo/institution-correspondence-repo.js';

export {
  makeOfficialEmailLookup,
  type OfficialEmailLookupConfig,
} from './shell/repo/official-email-lookup.js';

export { makePublicDebateTemplateRenderer } from './shell/templates/public-debate-request.js';

export {
  makeInstitutionCorrespondenceAdminRoutes,
  type InstitutionCorrespondenceAdminRoutesDeps,
} from './shell/rest/admin-routes.js';

export {
  makeInstitutionCorrespondenceRoutes,
  type InstitutionCorrespondenceRoutesDeps,
} from './shell/rest/routes.js';

export {
  makeInstitutionCorrespondenceAdminAuthHook,
  INSTITUTION_CORRESPONDENCE_ADMIN_API_KEY_HEADER,
  type InstitutionCorrespondenceAdminAuthConfig,
} from './shell/rest/admin-auth.js';

export {
  makeInstitutionCorrespondenceResendSideEffect,
  type InstitutionCorrespondenceResendSideEffectDeps,
} from './shell/webhook/resend-side-effect.js';
