import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { unwrapWorkerResult } from './worker-helpers.js';
import {
  DigestMaterializeJobPayloadSchema,
  type DigestMaterializeJobPayload,
} from '../../../core/digest/schemas.js';
import {
  materializeDueDigests,
  type MaterializeDueDigestsDeps,
  type MaterializeDueDigestsResult,
} from '../../../core/digest/usecases/materialize-due-digests.js';

import type { Redis } from 'ioredis';

export interface DigestWorkerDeps extends MaterializeDueDigestsDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
}

export const processDigestJob = async (
  deps: MaterializeDueDigestsDeps,
  payload: unknown
): Promise<MaterializeDueDigestsResult> => {
  if (!Value.Check(DigestMaterializeJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid digest materialization job payload');
  }

  deps.logger.info('Processing digest materialization job', { limit: payload.limit });
  const result = await materializeDueDigests(deps, { limit: payload.limit });
  return unwrapWorkerResult(result, deps.logger, 'Digest materialization job failed', {
    limit: payload.limit,
  });
};

export const createDigestWorker = (deps: DigestWorkerDeps): Worker<DigestMaterializeJobPayload> =>
  new Worker<DigestMaterializeJobPayload>(
    QUEUE_NAMES.NP_DIGEST,
    async (job) => processDigestJob(deps, job.data),
    {
      connection: deps.redis,
      prefix: deps.bullmqPrefix,
      concurrency: deps.concurrency ?? 1,
    }
  );
