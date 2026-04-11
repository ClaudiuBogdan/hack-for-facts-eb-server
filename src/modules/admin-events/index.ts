export type {
  AdminEventError,
  AdminEventValidationError,
  AdminEventQueueError,
  AdminEventFilesystemError,
  AdminEventNotFoundError,
} from './core/errors.js';

export {
  createValidationError,
  createQueueError,
  createFilesystemError,
  createNotFoundError,
} from './core/errors.js';

export type {
  AdminEventType,
  AdminEventJobEnvelope,
  AdminEventPendingJob,
  AdminEventQueueJobState,
  AdminEventExportBundle,
  AdminEventBaseExportBundle,
  AdminEventExportManifest,
  AdminEventStateClassification,
  AdminEventApplyResult,
  AdminEventDefinition,
} from './core/types.js';

export type { AdminEventQueuePort, AdminEventBundleStore } from './core/ports.js';

export { AdminEventJobEnvelopeSchema, AdminEventExportBundleSchema } from './core/schemas.js';

export type { AdminEventRegistry } from './core/registry.js';
export { makeAdminEventRegistry } from './core/registry.js';
export { validateSchema } from './core/validation.js';

export {
  queueAdminEvent,
  type QueueAdminEventDeps,
  type QueueAdminEventInput,
  type QueueAdminEventOutput,
} from './core/usecases/queue-admin-event.js';
export {
  queueManyAdminEvents,
  type QueueManyAdminEventsDeps,
  type QueueManyAdminEventsInput,
  type QueueManyAdminEventsOutput,
} from './core/usecases/queue-many-admin-events.js';
export {
  scanAndQueueAdminEvents,
  type ScanAndQueueAdminEventsDeps,
  type ScanAndQueueAdminEventsInput,
  type ScanAndQueueAdminEventsOutput,
} from './core/usecases/scan-and-queue-admin-events.js';
export {
  listAdminEventJobs,
  type ListAdminEventJobsDeps,
  type ListAdminEventJobsInput,
} from './core/usecases/list-admin-event-jobs.js';
export {
  exportAdminEventBundles,
  type ExportAdminEventBundlesDeps,
  type ExportAdminEventBundlesInput,
} from './core/usecases/export-admin-event-bundles.js';
export {
  applyAdminEventOutcome,
  type ApplyAdminEventOutcomeDeps,
  type ApplyAdminEventOutcomeInput,
} from './core/usecases/apply-admin-event-outcome.js';
export {
  reconcileAdminEventQueue,
  type ReconcileAdminEventQueueDeps,
  type ReconcileAdminEventQueueInput,
  type ReconcileAdminEventQueueOutput,
} from './core/usecases/reconcile-admin-event-queue.js';

export { ADMIN_EVENT_JOB_NAME, getAdminEventJobOptions } from './shell/queue/job-options.js';
export {
  makeBullmqAdminEventQueue,
  type BullmqAdminEventQueueConfig,
} from './shell/queue/queue.js';
export {
  startAdminEventRuntime,
  type AdminEventRuntime,
  type AdminEventRuntimeConfig,
  type AdminEventRuntimeFactory,
} from './shell/queue/runtime.js';
export { makeLocalAdminEventBundleStore } from './shell/filesystem/bundle-store.js';

export {
  INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
  InstitutionCorrespondenceReplyReviewPendingPayloadSchema,
  InstitutionCorrespondenceReplyReviewPendingOutcomeSchema,
  makeInstitutionCorrespondenceReplyReviewPendingEventDefinition,
  type InstitutionCorrespondenceReplyReviewPendingPayload,
  type InstitutionCorrespondenceReplyReviewPendingOutcome,
  type InstitutionCorrespondenceReplyReviewPendingContext,
  type InstitutionCorrespondenceReplyReviewPendingEventDefinitionDeps,
} from './shell/events/institution-correspondence-reply-review-pending.js';
export {
  makeDefaultAdminEventRegistry,
  type DefaultAdminEventRegistryDeps,
} from './shell/registry.js';
export {
  createAdminEventScriptContext,
  type AdminEventScriptContext,
} from './shell/script-context.js';
