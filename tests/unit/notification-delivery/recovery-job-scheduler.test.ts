import { describe, expect, it } from 'vitest';

import {
  registerRecoveryJobScheduler,
  RECOVERY_JOB_ATTEMPTS,
  RECOVERY_JOB_BACKOFF_DELAY_MS,
  RECOVERY_JOB_NAME,
  RECOVERY_JOB_REMOVE_ON_COMPLETE_COUNT,
  RECOVERY_JOB_REMOVE_ON_FAIL_COUNT,
  RECOVERY_JOB_SCHEDULER_ID,
} from '@/modules/notification-delivery/index.js';

import type { RecoveryJobPayload } from '@/modules/notification-delivery/core/types.js';
import type { Queue } from 'bullmq';

describe('registerRecoveryJobScheduler', () => {
  it('registers the recovery scheduler with the expected repeat options and template', async () => {
    const calls: unknown[][] = [];
    const recoveryQueue = {
      upsertJobScheduler: async (...args: unknown[]) => {
        calls.push(args);
        return {} as never;
      },
    } as unknown as Queue<RecoveryJobPayload>;

    await registerRecoveryJobScheduler({
      recoveryQueue,
      intervalMinutes: 15,
      thresholdMinutes: 20,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      RECOVERY_JOB_SCHEDULER_ID,
      {
        every: 15 * 60 * 1000,
      },
      {
        name: RECOVERY_JOB_NAME,
        data: {
          thresholdMinutes: 20,
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
      },
    ]);
  });

  it('reuses the same scheduler id across repeated registrations', async () => {
    const schedulerIds: string[] = [];
    const recoveryQueue = {
      upsertJobScheduler: async (schedulerId: string) => {
        schedulerIds.push(schedulerId);
        return {} as never;
      },
    } as unknown as Queue<RecoveryJobPayload>;

    await registerRecoveryJobScheduler({
      recoveryQueue,
      intervalMinutes: 15,
      thresholdMinutes: 15,
    });
    await registerRecoveryJobScheduler({
      recoveryQueue,
      intervalMinutes: 30,
      thresholdMinutes: 45,
    });

    expect(schedulerIds).toEqual([RECOVERY_JOB_SCHEDULER_ID, RECOVERY_JOB_SCHEDULER_ID]);
  });

  it('throws an Error when scheduler registration fails', async () => {
    const recoveryQueue = {
      upsertJobScheduler: async () => {
        throw new Error('Redis unavailable');
      },
    } as unknown as Queue<RecoveryJobPayload>;

    await expect(
      registerRecoveryJobScheduler({
        recoveryQueue,
        intervalMinutes: 15,
        thresholdMinutes: 15,
      })
    ).rejects.toThrow('Redis unavailable');
  });
});
