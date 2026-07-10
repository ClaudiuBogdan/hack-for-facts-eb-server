import { describe, expect, it } from 'vitest';

import {
  makeEventFanOutScheduler,
  makeDigestMaterializeScheduler,
  makeRenderJobScheduler,
  makeSendJobScheduler,
  registerDigestSweepScheduler,
  registerIngestionScanSchedulers,
  registerPlatformRecoveryScheduler,
  registerRetentionScheduler,
  type PlatformRecoveryJobPayload,
  type RetentionJobPayload,
} from '@/modules/notification-platform/shell/queue/schedulers.js';

import type {
  RenderJobPayload,
  SendJobPayload,
} from '@/modules/notification-platform/core/delivery/schemas.js';
import type { DigestMaterializeJobPayload } from '@/modules/notification-platform/core/digest/schemas.js';
import type {
  EventFanOutJobPayload,
  IngestionScanJobPayload,
} from '@/modules/notification-platform/core/events/schemas.js';
import type { JobsOptions, JobSchedulerTemplateOptions, RepeatOptions } from 'bullmq';

interface AddCall<T> {
  name: string;
  data: T;
  opts: JobsOptions | undefined;
}

const makeAddQueue = <T>() => {
  const calls: AddCall<T>[] = [];
  return {
    calls,
    queue: {
      add: async (name: string, data: T, opts?: JobsOptions) => {
        calls.push({ name, data, opts });
        return undefined as never;
      },
    },
  };
};

interface SchedulerTemplate<T> {
  name?: string;
  data?: T;
  opts?: JobSchedulerTemplateOptions;
}

interface SchedulerCall<T> {
  id: string;
  repeat: Omit<RepeatOptions, 'key'>;
  template?: SchedulerTemplate<T>;
}

const makeSchedulerQueue = <T>() => {
  const calls: SchedulerCall<T>[] = [];
  return {
    calls,
    queue: {
      upsertJobScheduler: async (
        id: string,
        repeat: Omit<RepeatOptions, 'key'>,
        template?: SchedulerTemplate<T>
      ) => {
        calls.push({ id, repeat, ...(template === undefined ? {} : { template }) });
        return undefined as never;
      },
    },
  };
};

describe('notification platform schedulers', () => {
  it('enqueues fan-out and render jobs with stable ids and backoff', async () => {
    const fanOut = makeAddQueue<EventFanOutJobPayload>();
    const render = makeAddQueue<RenderJobPayload>();

    expect(
      (await makeEventFanOutScheduler(fanOut.queue).enqueue({ eventId: 'event-1' })).isOk()
    ).toBe(true);
    expect(
      (await makeRenderJobScheduler(render.queue).enqueue({ deliveryId: 'delivery-1' })).isOk()
    ).toBe(true);

    expect(fanOut.calls[0]).toEqual({
      name: 'fanout',
      data: { eventId: 'event-1' },
      opts: {
        jobId: 'fanout-event-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    expect(render.calls[0]).toEqual({
      name: 'render',
      data: { deliveryId: 'delivery-1' },
      opts: {
        jobId: 'render-delivery-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  });

  it('uses an attempt-scoped send job id when a dedupe token is provided', async () => {
    const send = makeAddQueue<SendJobPayload>();
    const scheduler = makeSendJobScheduler(send.queue);

    expect(
      (
        await scheduler.enqueue({ deliveryId: 'delivery-2' }, { delayMs: 12_345, dedupeToken: '2' })
      ).isOk()
    ).toBe(true);

    expect(send.calls[0]).toEqual({
      name: 'send',
      data: { deliveryId: 'delivery-2' },
      opts: {
        jobId: 'np-send-delivery-2-2',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        delay: 12_345,
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  });

  it('keeps the initial send job id stable when no dedupe token is provided', async () => {
    const send = makeAddQueue<SendJobPayload>();

    expect(
      (await makeSendJobScheduler(send.queue).enqueue({ deliveryId: 'delivery-3' })).isOk()
    ).toBe(true);

    expect(send.calls[0]?.opts?.jobId).toBe('np-send-delivery-3');
  });

  it('enqueues an on-demand digest sweep with complete retry options', async () => {
    const digest = makeAddQueue<DigestMaterializeJobPayload>();

    expect((await makeDigestMaterializeScheduler(digest.queue).enqueue({ limit: 25 })).isOk()).toBe(
      true
    );
    expect(digest.calls).toEqual([
      {
        name: 'materialize-digests',
        data: { limit: 25 },
        opts: {
          jobId: 'digest-sweep-25',
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ]);
  });

  it('registers one ingestion scheduler per source', async () => {
    const queue = makeSchedulerQueue<IngestionScanJobPayload>();

    await registerIngestionScanSchedulers(
      queue.queue,
      [{ sourceId: 'parliament' }, { sourceId: 'budget' }],
      60
    );

    expect(queue.calls).toEqual([
      {
        id: 'np-ingestion:parliament',
        repeat: { every: 60_000 },
        template: {
          name: 'scan-source',
          data: { sourceId: 'parliament' },
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 500 },
          },
        },
      },
      {
        id: 'np-ingestion:budget',
        repeat: { every: 60_000 },
        template: {
          name: 'scan-source',
          data: { sourceId: 'budget' },
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 500 },
          },
        },
      },
    ]);
  });

  it('registers recovery, digest, and daily retention sweeps', async () => {
    const recovery = makeSchedulerQueue<PlatformRecoveryJobPayload>();
    const digest = makeSchedulerQueue<DigestMaterializeJobPayload>();
    const retention = makeSchedulerQueue<RetentionJobPayload>();

    await registerPlatformRecoveryScheduler(recovery.queue, 2, 10);
    await registerDigestSweepScheduler(digest.queue, 5);
    await registerRetentionScheduler(retention.queue);

    const opts = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    };
    expect(recovery.calls).toEqual([
      {
        id: 'np-platform-recovery',
        repeat: { every: 120_000 },
        template: {
          name: 'recover-platform-work',
          data: { thresholdMinutes: 10 },
          opts,
        },
      },
    ]);
    expect(digest.calls).toEqual([
      {
        id: 'np-digest-sweep',
        repeat: { every: 300_000 },
        template: { name: 'materialize-due-digests', data: { limit: 500 }, opts },
      },
    ]);
    expect(retention.calls).toEqual([
      {
        id: 'np-retention',
        repeat: { every: 86_400_000 },
        template: { name: 'apply-retention', data: { batchLimit: 500 }, opts },
      },
    ]);
  });
});
