import { describe, expect, it } from 'vitest';

import { makeComposeJobScheduler } from '@/modules/notification-delivery/index.js';

import type { ComposeJobPayload } from '@/modules/notification-delivery/core/types.js';
import type { Queue } from 'bullmq';

describe('makeComposeJobScheduler', () => {
  it('schedules outbox compose jobs with a stable id and cleanup options', async () => {
    const calls: {
      name: string;
      data: ComposeJobPayload;
      opts: Record<string, unknown> | undefined;
    }[] = [];

    const composeQueue = {
      add: async (name: string, data: ComposeJobPayload, opts?: Record<string, unknown>) => {
        calls.push({ name, data, opts });
        return {} as never;
      },
    } as unknown as Queue<ComposeJobPayload>;

    const scheduler = makeComposeJobScheduler({ composeQueue });
    const payload: ComposeJobPayload = {
      runId: 'run-1',
      kind: 'outbox',
      outboxId: 'outbox-1',
    };

    const result = await scheduler.enqueue(payload);

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([
      {
        name: 'compose',
        data: payload,
        opts: {
          jobId: 'compose-outbox-outbox-1',
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ]);
  });

  it('keeps subscription compose job ids unchanged', async () => {
    const calls: {
      name: string;
      data: ComposeJobPayload;
      opts: Record<string, unknown> | undefined;
    }[] = [];

    const composeQueue = {
      add: async (name: string, data: ComposeJobPayload, opts?: Record<string, unknown>) => {
        calls.push({ name, data, opts });
        return {} as never;
      },
    } as unknown as Queue<ComposeJobPayload>;

    const scheduler = makeComposeJobScheduler({ composeQueue });
    const payload: ComposeJobPayload = {
      runId: 'run-2',
      kind: 'subscription',
      notificationId: 'notification-1',
      periodKey: '2026-03',
    };

    const result = await scheduler.enqueue(payload);

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([
      {
        name: 'compose',
        data: payload,
        opts: {
          jobId: 'compose-notification-1-2026-03',
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    ]);
  });

  it('returns QueueError when enqueue fails', async () => {
    const composeQueue = {
      add: async () => {
        throw new Error('Redis connection lost');
      },
    } as unknown as Queue<ComposeJobPayload>;

    const scheduler = makeComposeJobScheduler({ composeQueue });
    const result = await scheduler.enqueue({
      runId: 'run-3',
      kind: 'outbox',
      outboxId: 'outbox-3',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('QueueError');
      if (result.error.type === 'QueueError') {
        expect(result.error.message).toContain('Redis connection lost');
      }
    }
  });
});
