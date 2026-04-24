/**
 * Notification Delivery Module
 *
 * Handles the delivery pipeline for notifications using the outbox pattern.
 */

// Core types
export type {
  DeliveryStatus,
  BundleOutboxType,
  BundleOutboxMetadata,
  AnafForexebugDigestMetadata,
  NotificationOutboxType,
  NotificationOutboxRecord,
  DeliveryRecord,
  TriggerRequest,
  TriggerResponse,
  CollectJobPayload,
  ComposeSubscriptionJobPayload,
  ComposeOutboxJobPayload,
  ComposeJobPayload,
  SendJobPayload,
  RecoveryJobPayload,
  ResendEventType,
  ResendWebhookEvent,
} from './core/types.js';

export type {
  AdminReviewedInteractionNextStepLink,
  AdminReviewedInteractionOutboxMetadata,
} from './core/reviewed-interaction.js';
export type {
  PublicDebateAdminResponseOutboxMetadata,
  PublicDebateAdminResponseRecipientRole,
  PublicDebateAdminResponseStatus,
  PublicDebateEntityAudienceSummary,
} from './core/admin-response.js';
export type {
  PublicDebateAnnouncementOutboxMetadata,
  PublicDebateAnnouncementPayload,
} from './core/public-debate-announcement.js';
export type {
  WeeklyProgressDigestSnapshot,
  WeeklyProgressDigestOutboxMetadata,
} from './core/weekly-progress-digest.js';

export {
  TERMINAL_STATUSES,
  CLAIMABLE_STATUSES,
  isReadyToSendDelivery,
  BUNDLE_OUTBOX_TYPES,
  ANAF_FOREXEBUG_DIGEST_SCOPE_PREFIX,
  isBundleOutboxType,
  buildAnafForexebugDigestScopeKey,
  parseAnafForexebugDigestScopeKey,
  MAX_RETRY_ATTEMPTS,
  STUCK_SENDING_THRESHOLD_MINUTES,
} from './core/types.js';

export {
  PUBLIC_DEBATE_ADMIN_RESPONSE_EVENT_TYPE,
  PUBLIC_DEBATE_ADMIN_RESPONSE_FAMILY_ID,
  PublicDebateAdminResponseOutboxMetadataSchema,
  PublicDebateAdminResponseRecipientRoleSchema,
  PublicDebateAdminResponseStatusSchema,
  buildPublicDebateEntityAudienceSummaryKey,
  parsePublicDebateAdminResponseOutboxMetadata,
} from './core/admin-response.js';
export {
  PUBLIC_DEBATE_ANNOUNCEMENT_FAMILY_ID,
  PUBLIC_DEBATE_ANNOUNCEMENT_TEMPLATE_ID,
  PUBLIC_DEBATE_ANNOUNCEMENT_TIME_ZONE,
  PublicDebateAnnouncementPayloadSchema,
  PublicDebateAnnouncementOutboxMetadataSchema,
  isPublicDebateAnnouncementAfterTriggerTime,
  parsePublicDebateAnnouncementOutboxMetadata,
} from './core/public-debate-announcement.js';
export {
  ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
  AdminReviewedInteractionNextStepLinkSchema,
  AdminReviewedInteractionOutboxMetadataSchema,
  parseAdminReviewedInteractionOutboxMetadata,
} from './core/reviewed-interaction.js';
export {
  WEEKLY_PROGRESS_DIGEST_TEMPLATE_ID,
  WEEKLY_PROGRESS_DIGEST_FAMILY_ID,
  FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE,
  WEEKLY_PROGRESS_DIGEST_SCOPE_PREFIX,
  WeeklyProgressDigestSnapshotSchema,
  WeeklyProgressDigestOutboxMetadataSchema,
  parseWeeklyProgressDigestOutboxMetadata,
  buildWeeklyProgressDigestScopeKey,
  buildWeeklyProgressDigestDeliveryKey,
} from './core/weekly-progress-digest.js';

// Core errors
export type {
  DeliveryError,
  DatabaseError,
  ValidationError,
  DuplicateDeliveryError,
  DeliveryNotFoundError,
  NotificationNotFoundError,
  UserEmailNotFoundError,
  UserEmailLookupError,
  DeliveryAlreadyClaimedError,
  RenderError,
  EmailSendError,
  QueueError,
  WebhookVerificationError,
  DuplicateWebhookEventError,
} from './core/errors.js';

export {
  createDatabaseError,
  createValidationError,
  createDuplicateDeliveryError,
  createDeliveryNotFoundError,
  createNotificationNotFoundError,
  createUserEmailNotFoundError,
  createUserEmailLookupError,
  createDeliveryAlreadyClaimedError,
  createRenderError,
  createEmailSendError,
  createQueueError,
  createWebhookVerificationError,
  createDuplicateWebhookEventError,
  isRetryableError,
  getErrorMessage,
} from './core/errors.js';

// Core ports
export type {
  NotificationOutboxRepository,
  DeliveryRepository,
  CreateNotificationOutboxInput,
  CreateDeliveryInput,
  UpdateRenderedContentInput,
  UpdateDeliveryStatusInput,
  ExtendedNotificationsRepository,
  PublicDebateEntityAudienceSummaryReader,
  ComposeJobScheduler,
  UserEmailFetcher,
  EmailSenderPort,
  SendEmailParams,
  SendEmailResult,
  WebhookVerifier,
  SvixHeaders,
  WebhookSignatureError,
  LoggerPort,
  DataFetcher,
  NewsletterData,
  AlertData,
  TargetedNotificationEligibility,
  TargetedNotificationEligibilityReason,
  UserScopedNotificationEligibility,
  WeeklyProgressDigestPostSendReconciler,
} from './core/ports.js';

// Shell - Repositories
export { makeDeliveryRepo } from './shell/repo/delivery-repo.js';
export type { DeliveryRepoConfig } from './shell/repo/delivery-repo.js';

export { makeExtendedNotificationsRepo } from './shell/repo/extended-notifications-repo.js';
export type { ExtendedNotificationsRepoOptions } from './shell/repo/extended-notifications-repo.js';
export {
  makePublicDebateEntityAudienceSummaryReader,
  type PublicDebateEntityAudienceSummaryReaderConfig,
} from './shell/repo/public-debate-entity-audience-summary-reader.js';
export {
  makeBudgetDataFetcher,
  makeBudgetMonthlyYtdTotalsReader,
  type BudgetDataFetcherConfig,
  type BudgetMonthlyYtdTotalsReaderConfig,
  type MonthlyYtdTotalsReader,
} from './shell/data/budget-data-fetcher.js';

// Shell - Queue Workers
export {
  createCollectWorker,
  createComposeWorker,
  createRecoveryWorker,
  createSendWorker,
  makeComposeJobScheduler,
  createWorkerManager,
  startNotificationDeliveryRuntime,
  RECOVERY_JOB_ATTEMPTS,
  RECOVERY_JOB_BACKOFF_DELAY_MS,
  RECOVERY_JOB_NAME,
  RECOVERY_JOB_REMOVE_ON_COMPLETE_COUNT,
  RECOVERY_JOB_REMOVE_ON_FAIL_COUNT,
  RECOVERY_JOB_SCHEDULER_ID,
  registerRecoveryJobScheduler,
  startNotificationRecoveryRuntime,
} from './shell/queue/index.js';

export type {
  CollectWorkerDeps,
  ComposeWorkerDeps,
  RecoveryWorkerDeps,
  SendWorkerDeps,
  ComposeJobSchedulerConfig,
  NotificationDeliveryRuntime,
  NotificationDeliveryRuntimeConfig,
  NotificationDeliveryRuntimeFactory,
  NotificationRecoveryRuntime,
  NotificationRecoveryRuntimeConfig,
  NotificationRecoveryRuntimeFactory,
  RegisterRecoveryJobSchedulerConfig,
  WorkerManager,
  WorkerManagerConfig,
} from './shell/queue/index.js';

// Shell - REST Routes
export { makeTriggerRoutes } from './shell/rest/trigger-routes.js';
export type { TriggerRoutesDeps } from './shell/rest/trigger-routes.js';
export { makeAnafForexebugDigestTriggerRoutes } from './shell/rest/anaf-forexebug-digest-trigger-routes.js';
export type { AnafForexebugDigestTriggerRoutesDeps } from './shell/rest/anaf-forexebug-digest-trigger-routes.js';

export {
  makeResendWebhookDeliverySideEffect,
  type ResendWebhookDeliverySideEffectDeps,
} from './shell/webhook/resend-side-effect.js';

// Core Use Cases
export { recoverStuckSending } from './core/usecases/recover-stuck-sending.js';
export {
  enqueueTransactionalWelcomeNotification,
  type EnqueueTransactionalWelcomeNotificationDeps,
  type EnqueueTransactionalWelcomeNotificationResult,
  type UserRegisteredEvent,
} from './core/usecases/enqueue-transactional-welcome-notification.js';
export {
  enqueuePublicDebateAnnouncementNotification,
  type EnqueuePublicDebateAnnouncementNotificationDeps,
  type PublicDebateAnnouncementNotificationInput,
  type EnqueuePublicDebateAnnouncementNotificationResult,
  type PublicDebateAnnouncementExecutionReason,
} from './core/usecases/enqueue-public-debate-announcement-notification.js';
export {
  buildPublicDebateAnnouncementDeliveryKey,
  buildPublicDebateAnnouncementScopeKey,
} from './core/usecases/public-debate-announcement-keys.js';
export {
  enqueuePublicDebateAdminFailureNotifications,
  type EnqueuePublicDebateAdminFailureNotificationsDeps,
  type EnqueuePublicDebateAdminFailureNotificationsResult,
  type PublicDebateAdminFailureNotificationInput,
} from './core/usecases/enqueue-public-debate-admin-failure-notifications.js';
export {
  enqueuePublicDebateAdminResponseNotifications,
  type EnqueuePublicDebateAdminResponseNotificationsDeps,
  type EnqueuePublicDebateAdminResponseNotificationsResult,
  type PublicDebateAdminResponseNotificationInput,
} from './core/usecases/enqueue-public-debate-admin-response-notifications.js';
export {
  enqueuePublicDebateEntityUpdateNotifications,
  type EnqueuePublicDebateEntityUpdateNotificationsDeps,
  type EnqueuePublicDebateEntityUpdateNotificationsResult,
  type PublicDebateEntityUpdateNotificationInput,
  type PublicDebateEntityUpdateEventType,
} from './core/usecases/enqueue-public-debate-entity-update-notifications.js';
export {
  enqueueAdminReviewedInteractionNotification,
  type EnqueueAdminReviewedInteractionNotificationDeps,
  type EnqueueAdminReviewedInteractionNotificationResult,
  type AdminReviewedInteractionNotificationInput,
  type AdminReviewedInteractionStaleGuardResult,
  type AdminReviewedInteractionExecutionReason,
} from './core/usecases/enqueue-admin-reviewed-interaction-notification.js';
export {
  enqueueWeeklyProgressDigestNotification,
  type EnqueueWeeklyProgressDigestNotificationDeps,
  type WeeklyProgressDigestNotificationInput,
  type EnqueueWeeklyProgressDigestNotificationResult,
  type WeeklyProgressDigestExecutionReason,
} from './core/usecases/enqueue-weekly-progress-digest-notification.js';
export {
  buildPublicDebateAdminResponseDeliveryKey,
  buildPublicDebateAdminResponseScopeKey,
  type PublicDebateAdminResponseKeyInput,
} from './core/usecases/public-debate-admin-response-keys.js';
export {
  buildPublicDebateEntityUpdateDeliveryKey,
  buildPublicDebateEntityUpdateScopeKey,
  type PublicDebateEntityUpdateKeyInput,
} from './core/usecases/public-debate-entity-update-keys.js';
export {
  buildAdminReviewedInteractionDeliveryKey,
  buildAdminReviewedInteractionScopeKey,
  type AdminReviewedInteractionKeyInput,
} from './core/usecases/admin-reviewed-interaction-keys.js';
export { createWeeklyProgressDigestPostSendReconciler } from './shell/queue/workers/weekly-progress-digest-post-send-reconciler.js';
export {
  enqueuePublicDebateTermsAcceptedNotifications,
  type EnqueuePublicDebateTermsAcceptedNotificationsDeps,
  type EnqueuePublicDebateTermsAcceptedNotificationsResult,
  type PublicDebateTermsAcceptedEvent,
} from './core/usecases/enqueue-public-debate-terms-accepted-notifications.js';
export { materializeAnafForexebugDigests } from './core/usecases/materialize-anaf-forexebug-digests.js';
export type {
  MaterializeAnafForexebugDigestsDeps,
  MaterializeAnafForexebugDigestsInput,
  MaterializeAnafForexebugDigestsResult,
} from './core/usecases/materialize-anaf-forexebug-digests.js';
export type {
  RecoverStuckSendingDeps,
  RecoverStuckSendingInput,
  RecoverStuckSendingResult,
} from './core/usecases/recover-stuck-sending.js';

// Shell - Mock Email Sender
export {
  makeMockEmailSender,
  getDefaultMockNotificationDir,
  type MockEmailSenderConfig,
} from './shell/email/mock-sender.js';
export {
  makeResendEmailSender,
  type ResendEmailSenderConfig,
} from './shell/email/resend-sender.js';

export {
  makeClerkUserEmailFetcher,
  type ClerkUserEmailFetcherConfig,
  type ClerkFetch,
} from './shell/clerk/user-email-fetcher.js';
