import { UnrecoverableError } from 'bullmq';
import pinoLogger from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSendJobOptions } from '@/modules/notification-delivery/shell/queue/send-job-options.js';
import { processRecoveryJob } from '@/modules/notification-delivery/shell/queue/workers/recovery-worker.js';

import { createTestDeliveryRecord, makeFakeDeliveryRepo } from '../../fixtures/fakes.js';

const testLogger = pinoLogger({ level: 'silent' });

describe('processRecoveryJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers stuck deliveries and returns counts', async () => {
    const stuckDelivery = createTestDeliveryRecord({
      id: 'delivery-stuck',
      status: 'sending',
      lastAttemptAt: new Date('2025-01-15T11:30:00Z'),
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [stuckDelivery] });
    const add = vi.fn(async () => ({}) as never);

    const result = await processRecoveryJob(
      {
        deliveryRepo,
        composeQueue: { add } as never,
        sendQueue: { add } as never,
        logger: testLogger,
      },
      {
        thresholdMinutes: 15,
      }
    );

    expect(result.foundCount).toBe(1);
    expect(result.recoveredCount).toBe(1);
    expect(result.recoveredIds).toEqual(['delivery-stuck']);
    expect(result.errors).toEqual({});
    expect(add).toHaveBeenCalledWith(
      'send',
      { outboxId: 'delivery-stuck' },
      getSendJobOptions('delivery-stuck')
    );
  });

  it('returns zero counts when no deliveries are stuck', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const add = vi.fn(async () => ({}) as never);

    const result = await processRecoveryJob(
      {
        deliveryRepo,
        composeQueue: { add } as never,
        sendQueue: { add } as never,
        logger: testLogger,
      },
      {
        thresholdMinutes: 15,
      }
    );

    expect(result.foundCount).toBe(0);
    expect(result.recoveredCount).toBe(0);
    expect(result.recoveredIds).toEqual([]);
    expect(result.errors).toEqual({});
    expect(add).not.toHaveBeenCalled();
  });

  it('throws a retryable error when the repository fails', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({ simulateDbError: true });
    const add = vi.fn(async () => ({}) as never);

    await expect(
      processRecoveryJob(
        {
          deliveryRepo,
          composeQueue: { add } as never,
          sendQueue: { add } as never,
          logger: testLogger,
        },
        {
          thresholdMinutes: 15,
        }
      )
    ).rejects.toThrow('Simulated database error');
  });

  it('throws UnrecoverableError for invalid payloads', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const add = vi.fn(async () => ({}) as never);

    await expect(
      processRecoveryJob(
        {
          deliveryRepo,
          composeQueue: { add } as never,
          sendQueue: { add } as never,
          logger: testLogger,
        },
        {
          thresholdMinutes: 0,
        }
      )
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
