// ─────────────────────────────────────────────────────────────────────────────
// Registry and event entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export { makeKindRegistry } from './core/registry/registry.js';
export type { KindRegistry } from './core/registry/registry.js';
export type { KindDefinition } from './core/registry/kind-definition.js';
export { ALL_NOTIFICATION_KINDS } from './core/registry/kinds/index.js';
export { recordNotificationEvent } from './core/events/usecases/record-notification-event.js';
export type {
  RecordNotificationEventDeps,
  RecordNotificationEventInput,
} from './core/events/usecases/record-notification-event.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ports used at the composition root
// ─────────────────────────────────────────────────────────────────────────────

export type {
  EventSourcePort,
  EventFanOutScheduler,
  NotificationEventRepo,
  SourceWatermarkRepo,
} from './core/events/ports.js';
export type { LoggerPort } from './core/shared/ports.js';
export type { SubjectAuthorizationPort, SubscriptionRepo } from './core/subscriptions/ports.js';
export type { PreferenceRepo } from './core/preferences/ports.js';
export type { LogicalNotificationRepo } from './core/inbox/ports.js';
export type {
  AnonymizationCheckPort,
  ChannelAdapterPort,
  ChannelDestinationRepo,
  DeliveryAttemptRepo,
  DeliveryRepo,
  RenderJobScheduler,
  SendJobScheduler,
} from './core/delivery/ports.js';
export type { DigestBatchRepo } from './core/digest/ports.js';
export type { AuditLedgerPort } from './core/audit/ports.js';
export { NOTIFICATION_PLATFORM_ADMIN_PERMISSION } from './core/admin/policies.js';
export type { LegacyOutboxReader } from './core/admin/usecases/get-shadow-comparison.js';
export type { NotificationEventTraceReader } from './core/admin/usecases/trace-event.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors and constructors
// ─────────────────────────────────────────────────────────────────────────────

export type {
  DatabaseError,
  ForbiddenError,
  NotFoundError,
  QueueError,
  SharedError,
  ValidationError,
} from './core/shared/errors.js';
export {
  createDatabaseError,
  createForbiddenError,
  createNotFoundError,
  createQueueError,
  createValidationError,
  isRetryableError,
} from './core/shared/errors.js';
export type {
  EventError,
  EventPayloadConflictError,
  EventSourceError,
} from './core/events/errors.js';
export { createEventPayloadConflictError, createEventSourceError } from './core/events/errors.js';
export type { SubscriptionConflictError, SubscriptionError } from './core/subscriptions/errors.js';
export { createSubscriptionConflictError } from './core/subscriptions/errors.js';
export type { PreferenceError } from './core/preferences/errors.js';
export type { InboxError } from './core/inbox/errors.js';
export type {
  DeliveryConflictError,
  DeliveryRenderError,
  DestinationUnavailableError,
  InvalidDeliveryTransitionError,
  PlatformDeliveryError,
  ProviderDeliveryError,
} from './core/delivery/errors.js';
export {
  createDeliveryConflictError,
  createDeliveryRenderError,
  createDestinationUnavailableError,
  createInvalidDeliveryTransitionError,
  createProviderDeliveryError,
} from './core/delivery/errors.js';
export type { DigestConflictError, DigestError } from './core/digest/errors.js';
export { createDigestConflictError } from './core/digest/errors.js';
export type { AuditAppendError, AuditError } from './core/audit/errors.js';
export { createAuditAppendError } from './core/audit/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Repository and infrastructure factories
// ─────────────────────────────────────────────────────────────────────────────

export { makeNotificationEventRepo } from './shell/repo/notification-event-repo.js';
export { makeSourceWatermarkRepo } from './shell/repo/source-watermark-repo.js';
export { makeSubscriptionRepo } from './shell/repo/subscription-repo.js';
export { makePreferenceRepo } from './shell/repo/preference-repo.js';
export { makeLogicalNotificationRepo } from './shell/repo/logical-notification-repo.js';
export { makeDeliveryRepo } from './shell/repo/delivery-repo.js';
export { makeDeliveryAttemptRepo } from './shell/repo/delivery-attempt-repo.js';
export { makeChannelDestinationRepo } from './shell/repo/channel-destination-repo.js';
export { makeDigestBatchRepo } from './shell/repo/digest-batch-repo.js';
export { makeAuditLedgerRepo } from './shell/repo/audit-ledger-repo.js';
export { makeAnonymizationCheckRepo } from './shell/repo/anonymization-check-repo.js';
export {
  makeEmailChannelAdapter,
  type EmailChannelAdapterConfig,
} from './shell/channel/email-channel-adapter.js';
export {
  makeResendPlatformWebhookSideEffect,
  type ResendPlatformWebhookSideEffectDeps,
} from './shell/webhook/resend-platform-side-effect.js';
export {
  makeRetentionRunner,
  type RetentionRunner,
  type RetentionSummary,
} from './shell/retention/apply-retention.js';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export {
  startNotificationPlatformRuntime,
  type NotificationPlatformRuntime,
  type NotificationPlatformRuntimeConfig,
  type NotificationPlatformRuntimeFactories,
  type NotificationPlatformRuntimeFactory,
  type NotificationPlatformWorkerDeps,
} from './shell/queue/platform-runtime.js';

// ─────────────────────────────────────────────────────────────────────────────
// REST routes
// ─────────────────────────────────────────────────────────────────────────────

export { makeInboxRoutes, type MakeInboxRoutesDeps } from './shell/rest/inbox-routes.js';
export {
  makeSubscriptionRoutes,
  type MakeSubscriptionRoutesDeps,
} from './shell/rest/subscription-routes.js';
export {
  makePreferenceRoutes,
  type MakePreferenceRoutesDeps,
} from './shell/rest/preference-routes.js';
export {
  makePlatformAdminRoutes,
  type MakePlatformAdminRoutesDeps,
  type PlatformAdminRoutesFactory,
} from './shell/rest/admin-routes.js';
