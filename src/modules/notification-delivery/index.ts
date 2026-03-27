/**
 * Notification Delivery Module
 *
 * Handles the delivery pipeline for notifications using the outbox pattern.
 */

// Core types
export type {
  DeliveryStatus,
  DeliveryRecord,
  TriggerRequest,
  TriggerResponse,
  CollectJobPayload,
  ComposeJobPayload,
  SendJobPayload,
  ResendEventType,
  ResendWebhookEvent,
} from './core/types.js';

export {
  TERMINAL_STATUSES,
  CLAIMABLE_STATUSES,
  MAX_RETRY_ATTEMPTS,
  STUCK_SENDING_THRESHOLD_MINUTES,
} from './core/types.js';

// Core errors
export type {
  DeliveryError,
  DatabaseError,
  DuplicateDeliveryError,
  DeliveryNotFoundError,
  NotificationNotFoundError,
  UserEmailNotFoundError,
  DeliveryAlreadyClaimedError,
  RenderError,
  EmailSendError,
  WebhookVerificationError,
  DuplicateWebhookEventError,
} from './core/errors.js';

export {
  createDatabaseError,
  createDuplicateDeliveryError,
  createDeliveryNotFoundError,
  createNotificationNotFoundError,
  createUserEmailNotFoundError,
  createDeliveryAlreadyClaimedError,
  createRenderError,
  createEmailSendError,
  createWebhookVerificationError,
  createDuplicateWebhookEventError,
  isRetryableError,
  getErrorMessage,
} from './core/errors.js';

// Core ports
export type {
  DeliveryRepository,
  CreateDeliveryInput,
  UpdateDeliveryStatusInput,
  ExtendedNotificationsRepository,
  ExtendedTokensRepository,
  UserEmailFetcher,
  EmailSenderPort,
  SendEmailParams,
  SendEmailResult,
  WebhookVerifier,
  SvixHeaders,
  WebhookSignatureError,
  DataFetcher,
  NewsletterData,
  AlertData,
} from './core/ports.js';

// Shell - Repositories
export { makeDeliveryRepo } from './shell/repo/delivery-repo.js';
export type { DeliveryRepoConfig } from './shell/repo/delivery-repo.js';

// Shell - Queue Workers
export {
  createCollectWorker,
  createComposeWorker,
  createSendWorker,
  createWorkerManager,
} from './shell/queue/index.js';

export type {
  CollectWorkerDeps,
  ComposeWorkerDeps,
  SendWorkerDeps,
  WorkerManager,
  WorkerManagerConfig,
} from './shell/queue/index.js';

// Shell - REST Routes
export { makeTriggerRoutes } from './shell/rest/trigger-routes.js';
export type { TriggerRoutesDeps } from './shell/rest/trigger-routes.js';

export {
  makeResendWebhookDeliverySideEffect,
  type ResendWebhookDeliverySideEffectDeps,
} from './shell/webhook/resend-side-effect.js';

// Core Use Cases
export { recoverStuckSending } from './core/usecases/recover-stuck-sending.js';
export type {
  RecoverStuckSendingDeps,
  RecoverStuckSendingInput,
  RecoverStuckSendingResult,
} from './core/usecases/recover-stuck-sending.js';
