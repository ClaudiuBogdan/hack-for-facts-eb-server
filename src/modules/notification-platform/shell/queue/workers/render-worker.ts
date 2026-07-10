import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { unwrapWorkerResult } from './worker-helpers.js';
import { RenderJobPayloadSchema, type RenderJobPayload } from '../../../core/delivery/schemas.js';
import {
  renderDelivery,
  type RenderDeliveryDeps,
  type RenderDeliveryResult,
} from '../../../core/delivery/usecases/render-delivery.js';

import type { Redis } from 'ioredis';

export interface RenderWorkerDeps extends RenderDeliveryDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
}

export const processRenderJob = async (
  deps: RenderDeliveryDeps,
  payload: unknown
): Promise<RenderDeliveryResult> => {
  if (!Value.Check(RenderJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid delivery render job payload');
  }

  deps.logger.info('Processing delivery render job', { deliveryId: payload.deliveryId });
  const result = await renderDelivery(deps, { deliveryId: payload.deliveryId });
  return unwrapWorkerResult(result, deps.logger, 'Delivery render job failed', {
    deliveryId: payload.deliveryId,
  });
};

export const createRenderWorker = (deps: RenderWorkerDeps): Worker<RenderJobPayload> =>
  new Worker<RenderJobPayload>(
    QUEUE_NAMES.NP_RENDER,
    async (job) => processRenderJob(deps, job.data),
    {
      connection: deps.redis,
      prefix: deps.bullmqPrefix,
      concurrency: deps.concurrency ?? 5,
    }
  );
