import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker, type WorkerOptions } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { unwrapWorkerResult } from './worker-helpers.js';
import { SendJobPayloadSchema, type SendJobPayload } from '../../../core/delivery/schemas.js';
import {
  dispatchDelivery,
  type DispatchDeliveryDeps,
  type DispatchDeliveryResult,
} from '../../../core/delivery/usecases/dispatch-delivery.js';

import type { Redis } from 'ioredis';

export interface SendWorkerDeps extends DispatchDeliveryDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
  maxSendRps: number;
}

export const processSendJob = async (
  deps: DispatchDeliveryDeps,
  payload: unknown
): Promise<DispatchDeliveryResult> => {
  if (!Value.Check(SendJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid delivery send job payload');
  }

  deps.logger.info('Processing delivery send job', { deliveryId: payload.deliveryId });
  const result = await dispatchDelivery(deps, { deliveryId: payload.deliveryId });
  return unwrapWorkerResult(result, deps.logger, 'Delivery send job failed', {
    deliveryId: payload.deliveryId,
  });
};

export const makeSendWorkerOptions = (
  deps: Pick<SendWorkerDeps, 'redis' | 'bullmqPrefix' | 'concurrency' | 'maxSendRps'>
): WorkerOptions => ({
  connection: deps.redis,
  prefix: deps.bullmqPrefix,
  concurrency: deps.concurrency ?? 5,
  limiter: { max: deps.maxSendRps, duration: 1000 },
});

export const createSendWorker = (deps: SendWorkerDeps): Worker<SendJobPayload> =>
  new Worker<SendJobPayload>(
    QUEUE_NAMES.NP_SEND,
    async (job) => processSendJob(deps, job.data),
    makeSendWorkerOptions(deps)
  );
