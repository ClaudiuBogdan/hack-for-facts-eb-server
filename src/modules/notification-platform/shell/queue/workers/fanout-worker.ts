import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { unwrapWorkerResult } from './worker-helpers.js';
import {
  EventFanOutJobPayloadSchema,
  type EventFanOutJobPayload,
} from '../../../core/events/schemas.js';
import {
  resolveEventRecipients,
  type ResolveEventRecipientsDeps,
  type ResolveEventRecipientsResult,
} from '../../../core/inbox/usecases/resolve-event-recipients.js';

import type { Redis } from 'ioredis';

export interface FanOutWorkerDeps extends ResolveEventRecipientsDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
}

export const processFanOutJob = async (
  deps: ResolveEventRecipientsDeps,
  payload: unknown
): Promise<ResolveEventRecipientsResult> => {
  if (!Value.Check(EventFanOutJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid event fan-out job payload');
  }

  deps.logger.info('Processing event fan-out job', { eventId: payload.eventId });
  const result = await resolveEventRecipients(deps, { eventId: payload.eventId });
  return unwrapWorkerResult(result, deps.logger, 'Event fan-out job failed', {
    eventId: payload.eventId,
  });
};

export const createFanOutWorker = (deps: FanOutWorkerDeps): Worker<EventFanOutJobPayload> =>
  new Worker<EventFanOutJobPayload>(
    QUEUE_NAMES.NP_FANOUT,
    async (job) => processFanOutJob(deps, job.data),
    {
      connection: deps.redis,
      prefix: deps.bullmqPrefix,
      concurrency: deps.concurrency ?? 5,
    }
  );
