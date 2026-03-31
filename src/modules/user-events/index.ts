/**
 * User Events Module
 *
 * Reference specification:
 * docs/specs/specs-202603311636-user-events-module.md
 */
export type {
  UserEventSource,
  LearningProgressInteractiveUpdatedUserEvent,
  LearningProgressResetUserEvent,
  UserEventJobPayload,
} from './core/types.js';

export { UserEventJobPayloadSchema } from './core/schemas.js';

export type { UserEventPublisher, UserEventHandler } from './core/ports.js';

export {
  buildLearningProgressUserEventJob,
  buildLearningProgressUserEventJobs,
} from './core/learning-progress.js';

export {
  USER_EVENT_JOB_NAME,
  USER_EVENT_JOB_ATTEMPTS,
  USER_EVENT_JOB_BACKOFF_DELAY_MS,
  USER_EVENT_JOB_REMOVE_ON_FAIL_COUNT,
  getUserEventJobId,
  getUserEventJobOptions,
  buildUserEventQueueJob,
} from './shell/queue/job-options.js';

export { makeUserEventPublisher, type UserEventPublisherConfig } from './shell/queue/publisher.js';

export {
  createUserEventWorker,
  processUserEventJob,
  type ProcessUserEventJobDeps,
  type UserEventJobResult,
  type CreateUserEventWorkerDeps,
} from './shell/queue/worker.js';

export {
  startUserEventRuntime,
  type UserEventRuntime,
  type UserEventRuntimeConfig,
  type UserEventRuntimeFactory,
} from './shell/queue/runtime.js';

export {
  createLearningProgressUserEventSyncHook,
  type LearningProgressUserEventSyncHookDeps,
  type LearningProgressUserEventSyncHookInput,
} from './shell/queue/learning-progress-sync-hook.js';

export {
  makePublicDebateRequestUserEventHandler,
  type PublicDebateRequestUserEventHandlerDeps,
} from './shell/handlers/public-debate-request-handler.js';
