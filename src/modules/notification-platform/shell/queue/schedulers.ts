import { err, ok, type Result } from 'neverthrow';

import { createQueueError, type QueueError } from '../../core/shared/errors.js';

import type { RenderJobScheduler, SendJobScheduler } from '../../core/delivery/ports.js';
import type { RenderJobPayload, SendJobPayload } from '../../core/delivery/schemas.js';
import type { DigestMaterializeJobPayload } from '../../core/digest/schemas.js';
import type { EventFanOutScheduler } from '../../core/events/ports.js';
import type { EventFanOutJobPayload, IngestionScanJobPayload } from '../../core/events/schemas.js';
import type { Queue } from 'bullmq';

type AddQueue<T> = Pick<Queue<T>, 'add'>;
type SchedulerQueue<T> = Pick<Queue<T>, 'upsertJobScheduler'>;

export interface PlatformRecoveryJobPayload {
  thresholdMinutes: number;
}

export interface RetentionJobPayload {
  batchLimit: number;
}

export interface DigestMaterializeScheduler {
  enqueue(payload: DigestMaterializeJobPayload): Promise<Result<void, QueueError>>;
}

const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_DELAY_MS = 5000;
const SCHEDULED_JOB_BACKOFF_DELAY_MS = 60_000;
const SCHEDULED_REMOVE_ON_COMPLETE_COUNT = 100;
const SCHEDULED_REMOVE_ON_FAIL_COUNT = 500;
const DEFAULT_SWEEP_BATCH_LIMIT = 500;

const onDemandJobOptions = (jobId: string, delayMs?: number) => ({
  jobId,
  attempts: JOB_ATTEMPTS,
  backoff: {
    type: 'exponential' as const,
    delay: JOB_BACKOFF_DELAY_MS,
  },
  ...(delayMs === undefined ? {} : { delay: delayMs }),
  removeOnComplete: true,
  removeOnFail: true,
});

const scheduledJobOptions = {
  attempts: JOB_ATTEMPTS,
  backoff: {
    type: 'exponential' as const,
    delay: SCHEDULED_JOB_BACKOFF_DELAY_MS,
  },
  removeOnComplete: { count: SCHEDULED_REMOVE_ON_COMPLETE_COUNT },
  removeOnFail: { count: SCHEDULED_REMOVE_ON_FAIL_COUNT },
};

const queueFailure = (error: unknown, fallback: string): QueueError =>
  createQueueError(error instanceof Error ? error.message : fallback, true);

export const makeEventFanOutScheduler = (
  queue: AddQueue<EventFanOutJobPayload>
): EventFanOutScheduler => ({
  async enqueue(payload) {
    try {
      await queue.add('fanout', payload, onDemandJobOptions(`fanout-${payload.eventId}`));
      return ok(undefined);
    } catch (error) {
      return err(queueFailure(error, 'Failed to enqueue event fan-out job'));
    }
  },
});

export const makeRenderJobScheduler = (queue: AddQueue<RenderJobPayload>): RenderJobScheduler => ({
  async enqueue(payload) {
    try {
      await queue.add('render', payload, onDemandJobOptions(`render-${payload.deliveryId}`));
      return ok(undefined);
    } catch (error) {
      return err(queueFailure(error, 'Failed to enqueue delivery render job'));
    }
  },
});

export const makeSendJobScheduler = (queue: AddQueue<SendJobPayload>): SendJobScheduler => ({
  async enqueue(payload, options) {
    try {
      const jobId =
        options?.dedupeToken === undefined
          ? `np-send-${payload.deliveryId}`
          : `np-send-${payload.deliveryId}-${options.dedupeToken}`;
      await queue.add('send', payload, onDemandJobOptions(jobId, options?.delayMs));
      return ok(undefined);
    } catch (error) {
      return err(queueFailure(error, 'Failed to enqueue delivery send job'));
    }
  },
});

export const makeDigestMaterializeScheduler = (
  queue: AddQueue<DigestMaterializeJobPayload>
): DigestMaterializeScheduler => ({
  async enqueue(payload) {
    try {
      await queue.add('materialize-digests', payload, {
        ...onDemandJobOptions(`digest-sweep-${String(payload.limit)}`),
      });
      return ok(undefined);
    } catch (error) {
      return err(queueFailure(error, 'Failed to enqueue digest materialization job'));
    }
  },
});

export const registerIngestionScanSchedulers = async (
  queue: SchedulerQueue<IngestionScanJobPayload>,
  sources: readonly { sourceId: string }[],
  intervalSeconds: number
): Promise<void> => {
  for (const source of sources) {
    await queue.upsertJobScheduler(
      `np-ingestion:${source.sourceId}`,
      { every: intervalSeconds * 1000 },
      {
        name: 'scan-source',
        data: { sourceId: source.sourceId },
        opts: scheduledJobOptions,
      }
    );
  }
};

export const registerPlatformRecoveryScheduler = async (
  queue: SchedulerQueue<PlatformRecoveryJobPayload>,
  intervalMinutes: number,
  thresholdMinutes: number
): Promise<void> => {
  await queue.upsertJobScheduler(
    'np-platform-recovery',
    { every: intervalMinutes * 60 * 1000 },
    {
      name: 'recover-platform-work',
      data: { thresholdMinutes },
      opts: scheduledJobOptions,
    }
  );
};

export const registerDigestSweepScheduler = async (
  queue: SchedulerQueue<DigestMaterializeJobPayload>,
  intervalMinutes: number
): Promise<void> => {
  await queue.upsertJobScheduler(
    'np-digest-sweep',
    { every: intervalMinutes * 60 * 1000 },
    {
      name: 'materialize-due-digests',
      data: { limit: DEFAULT_SWEEP_BATCH_LIMIT },
      opts: scheduledJobOptions,
    }
  );
};

export const registerRetentionScheduler = async (
  queue: SchedulerQueue<RetentionJobPayload>
): Promise<void> => {
  await queue.upsertJobScheduler(
    'np-retention',
    { every: 24 * 60 * 60 * 1000 },
    {
      name: 'apply-retention',
      data: { batchLimit: DEFAULT_SWEEP_BATCH_LIMIT },
      opts: scheduledJobOptions,
    }
  );
};
