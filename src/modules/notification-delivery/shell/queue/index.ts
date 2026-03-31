/**
 * Queue Module Exports
 */

export { createCollectWorker, type CollectWorkerDeps } from './workers/collect-worker.js';
export { createComposeWorker, type ComposeWorkerDeps } from './workers/compose-worker.js';
export {
  createRecoveryWorker,
  processRecoveryJob,
  type RecoveryWorkerDeps,
} from './workers/recovery-worker.js';
export { createSendWorker, type SendWorkerDeps } from './workers/send-worker.js';
export {
  makeComposeJobScheduler,
  type ComposeJobSchedulerConfig,
} from './compose-job-scheduler.js';
export {
  registerRecoveryJobScheduler,
  RECOVERY_JOB_ATTEMPTS,
  RECOVERY_JOB_BACKOFF_DELAY_MS,
  RECOVERY_JOB_NAME,
  RECOVERY_JOB_REMOVE_ON_COMPLETE_COUNT,
  RECOVERY_JOB_REMOVE_ON_FAIL_COUNT,
  RECOVERY_JOB_SCHEDULER_ID,
  type RegisterRecoveryJobSchedulerConfig,
} from './recovery-job-scheduler.js';
export {
  startNotificationDeliveryRuntime,
  type NotificationDeliveryRuntime,
  type NotificationDeliveryRuntimeConfig,
  type NotificationDeliveryRuntimeFactory,
} from './delivery-runtime.js';
export {
  startNotificationRecoveryRuntime,
  type NotificationRecoveryRuntime,
  type NotificationRecoveryRuntimeConfig,
  type NotificationRecoveryRuntimeFactory,
} from './recovery-runtime.js';
export {
  createWorkerManager,
  type WorkerManager,
  type WorkerManagerConfig,
} from './worker-manager.js';
