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
} from './core/ports.js';

// Shell - Repositories
export { makeDeliveryRepo } from './shell/repo/delivery-repo.js';
export type { DeliveryRepoConfig } from './shell/repo/delivery-repo.js';

export { makeExtendedNotificationsRepo } from './shell/repo/extended-notifications-repo.js';
export type { ExtendedNotificationsRepoOptions } from './shell/repo/extended-notifications-repo.js';
export {
  makeBudgetDataFetcher,
  type BudgetDataFetcherConfig,
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
  enqueuePublicDebateEntityUpdateNotifications,
  type EnqueuePublicDebateEntityUpdateNotificationsDeps,
  type EnqueuePublicDebateEntityUpdateNotificationsResult,
  type PublicDebateEntityUpdateNotificationInput,
  type PublicDebateEntityUpdateEventType,
} from './core/usecases/enqueue-public-debate-entity-update-notifications.js';
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
