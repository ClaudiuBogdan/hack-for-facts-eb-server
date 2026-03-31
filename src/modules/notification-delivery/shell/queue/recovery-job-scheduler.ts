import type { RecoveryJobPayload } from '../../core/types.js';
import type { Queue } from 'bullmq';

export const RECOVERY_JOB_SCHEDULER_ID = 'recovery:stuck-sending';
export const RECOVERY_JOB_NAME = 'recover-stuck-sending';
export const RECOVERY_JOB_ATTEMPTS = 3;
export const RECOVERY_JOB_BACKOFF_DELAY_MS = 60_000;
export const RECOVERY_JOB_REMOVE_ON_COMPLETE_COUNT = 100;
export const RECOVERY_JOB_REMOVE_ON_FAIL_COUNT = 500;

export interface RegisterRecoveryJobSchedulerConfig {
  recoveryQueue: Queue<RecoveryJobPayload>;
  intervalMinutes: number;
  thresholdMinutes: number;
}

export const registerRecoveryJobScheduler = async (
  config: RegisterRecoveryJobSchedulerConfig
): Promise<void> => {
  const { recoveryQueue, intervalMinutes, thresholdMinutes } = config;

  try {
    await recoveryQueue.upsertJobScheduler(
      RECOVERY_JOB_SCHEDULER_ID,
      {
        every: intervalMinutes * 60 * 1000,
      },
      {
        name: RECOVERY_JOB_NAME,
        data: {
          thresholdMinutes,
        },
        opts: {
          attempts: RECOVERY_JOB_ATTEMPTS,
          backoff: {
            type: 'exponential',
            delay: RECOVERY_JOB_BACKOFF_DELAY_MS,
          },
          removeOnComplete: {
            count: RECOVERY_JOB_REMOVE_ON_COMPLETE_COUNT,
          },
          removeOnFail: {
            count: RECOVERY_JOB_REMOVE_ON_FAIL_COUNT,
          },
        },
      }
    );
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to register recovery scheduler',
      {
        cause: error,
      }
    );
  }
};
