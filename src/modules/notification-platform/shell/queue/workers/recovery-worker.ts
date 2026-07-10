import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { unwrapWorkerResult } from './worker-helpers.js';
import {
  expireDueDeliveries,
  type ExpireDueDeliveriesDeps,
} from '../../../core/delivery/usecases/expire-due-deliveries.js';
import {
  recoverPlatformWork,
  type RecoverPlatformWorkDeps,
  type RecoverySummary,
} from '../../../core/delivery/usecases/recover-platform-work.js';

import type { PlatformRecoveryJobPayload } from '../schedulers.js';
import type { Redis } from 'ioredis';

const RECOVERY_BATCH_LIMIT = 500;
const PlatformRecoveryJobPayloadSchema = Type.Object(
  { thresholdMinutes: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
);

export interface RecoveryProcessorDeps extends RecoverPlatformWorkDeps, ExpireDueDeliveriesDeps {}

export interface RecoveryWorkerDeps extends RecoveryProcessorDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
}

export interface RecoveryWorkerResult extends RecoverySummary {
  expired: number;
}

export const processRecoveryJob = async (
  deps: RecoveryProcessorDeps,
  payload: unknown
): Promise<RecoveryWorkerResult> => {
  if (!Value.Check(PlatformRecoveryJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid platform recovery job payload');
  }

  deps.logger.info('Processing platform recovery job', {
    thresholdMinutes: payload.thresholdMinutes,
  });
  const recovered = await recoverPlatformWork(deps, {
    thresholdMinutes: payload.thresholdMinutes,
    limit: RECOVERY_BATCH_LIMIT,
  });
  const recoverySummary = unwrapWorkerResult(
    recovered,
    deps.logger,
    'Platform recovery job failed',
    { thresholdMinutes: payload.thresholdMinutes }
  );

  const expired = await expireDueDeliveries(deps, { limit: RECOVERY_BATCH_LIMIT });
  const expirySummary = unwrapWorkerResult(expired, deps.logger, 'Delivery expiry sweep failed', {
    thresholdMinutes: payload.thresholdMinutes,
  });
  return { ...recoverySummary, expired: expirySummary.expired };
};

export const createRecoveryWorker = (
  deps: RecoveryWorkerDeps
): Worker<PlatformRecoveryJobPayload> =>
  new Worker<PlatformRecoveryJobPayload>(
    QUEUE_NAMES.NP_RECOVERY,
    async (job) => processRecoveryJob(deps, job.data),
    {
      connection: deps.redis,
      prefix: deps.bullmqPrefix,
      concurrency: deps.concurrency ?? 1,
    }
  );
