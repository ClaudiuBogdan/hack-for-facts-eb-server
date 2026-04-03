import type { PlatformSendRecoveryJobPayload } from './recovery-types.js';
import type { Queue } from 'bullmq';

export const CORRESPONDENCE_RECOVERY_JOB_SCHEDULER_ID =
  'correspondence-recovery:platform-send-success';
export const CORRESPONDENCE_RECOVERY_JOB_NAME = 'recover-platform-send-success';
export const CORRESPONDENCE_RECOVERY_JOB_ATTEMPTS = 3;
export const CORRESPONDENCE_RECOVERY_JOB_BACKOFF_DELAY_MS = 60_000;
export const CORRESPONDENCE_RECOVERY_JOB_REMOVE_ON_COMPLETE_COUNT = 100;
export const CORRESPONDENCE_RECOVERY_JOB_REMOVE_ON_FAIL_COUNT = 500;

export interface RegisterCorrespondenceRecoveryJobSchedulerConfig {
  recoveryQueue: Queue<PlatformSendRecoveryJobPayload>;
  intervalMinutes: number;
  thresholdMinutes: number;
}

export const registerCorrespondenceRecoveryJobScheduler = async (
  config: RegisterCorrespondenceRecoveryJobSchedulerConfig
): Promise<void> => {
  const { recoveryQueue, intervalMinutes, thresholdMinutes } = config;

  await recoveryQueue.upsertJobScheduler(
    CORRESPONDENCE_RECOVERY_JOB_SCHEDULER_ID,
    {
      every: intervalMinutes * 60 * 1000,
    },
    {
      name: CORRESPONDENCE_RECOVERY_JOB_NAME,
      data: {
        thresholdMinutes,
      },
      opts: {
        attempts: CORRESPONDENCE_RECOVERY_JOB_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: CORRESPONDENCE_RECOVERY_JOB_BACKOFF_DELAY_MS,
        },
        removeOnComplete: {
          count: CORRESPONDENCE_RECOVERY_JOB_REMOVE_ON_COMPLETE_COUNT,
        },
        removeOnFail: {
          count: CORRESPONDENCE_RECOVERY_JOB_REMOVE_ON_FAIL_COUNT,
        },
      },
    }
  );
};
