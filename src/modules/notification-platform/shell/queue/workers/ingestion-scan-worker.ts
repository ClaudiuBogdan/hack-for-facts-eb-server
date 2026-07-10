import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { unwrapWorkerResult } from './worker-helpers.js';
import {
  IngestionScanJobPayloadSchema,
  type IngestionScanJobPayload,
} from '../../../core/events/schemas.js';
import {
  runIngestionScan,
  type RunIngestionScanDeps,
} from '../../../core/events/usecases/run-ingestion-scan.js';

import type { EventSourcePort } from '../../../core/events/ports.js';
import type { Redis } from 'ioredis';

const INGESTION_BATCH_LIMIT = 500;

export interface IngestionScanProcessorDeps extends Omit<RunIngestionScanDeps, 'source'> {
  eventSources: ReadonlyMap<string, EventSourcePort>;
}

export interface IngestionScanWorkerDeps extends IngestionScanProcessorDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
}

export type IngestionScanWorkerResult =
  | { recorded: number; duplicates: number; watermarkAdvanced: boolean }
  | { unknownSource: true };

export const processIngestionScanJob = async (
  deps: IngestionScanProcessorDeps,
  payload: unknown
): Promise<IngestionScanWorkerResult> => {
  if (!Value.Check(IngestionScanJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid ingestion scan job payload');
  }

  const source = deps.eventSources.get(payload.sourceId);
  if (source === undefined) {
    deps.logger.error('Unknown notification event source', { sourceId: payload.sourceId });
    return { unknownSource: true };
  }

  deps.logger.info('Processing ingestion scan job', { sourceId: payload.sourceId });
  const result = await runIngestionScan(
    {
      source,
      watermarks: deps.watermarks,
      events: deps.events,
      registry: deps.registry,
      audit: deps.audit,
      fanOutScheduler: deps.fanOutScheduler,
      clock: deps.clock,
      ids: deps.ids,
      logger: deps.logger,
    },
    { batchLimit: INGESTION_BATCH_LIMIT }
  );
  return unwrapWorkerResult(result, deps.logger, 'Ingestion scan job failed', {
    sourceId: payload.sourceId,
  });
};

export const createIngestionScanWorker = (
  deps: IngestionScanWorkerDeps
): Worker<IngestionScanJobPayload> =>
  new Worker<IngestionScanJobPayload>(
    QUEUE_NAMES.NP_INGESTION,
    async (job) => processIngestionScanJob(deps, job.data),
    {
      connection: deps.redis,
      prefix: deps.bullmqPrefix,
      concurrency: deps.concurrency ?? 5,
    }
  );
