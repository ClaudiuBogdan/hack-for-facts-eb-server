import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { UserEventJobPayloadSchema } from '../../core/schemas.js';

import type { UserEventHandler } from '../../core/ports.js';
import type { UserEventJobPayload } from '../../core/types.js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface ProcessUserEventJobDeps {
  handlers: readonly UserEventHandler[];
  logger: Logger;
}

export interface UserEventJobResult {
  status: 'handled' | 'skipped_unmatched';
  matchedHandlerNames: string[];
}

export interface CreateUserEventWorkerDeps extends ProcessUserEventJobDeps {
  redis: Redis;
  bullmqPrefix: string;
  concurrency?: number;
}

interface HandlerFailure {
  handlerName: string;
  error: Error;
}

const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error('Unknown user event handler error');
};

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const isValidOccurredAtTimestamp = (occurredAt: string): boolean => {
  return ISO_8601_REGEX.test(occurredAt.trim());
};

export const processUserEventJob = async (
  deps: ProcessUserEventJobDeps,
  payload: UserEventJobPayload
): Promise<UserEventJobResult> => {
  if (!Value.Check(UserEventJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid user event job payload');
  }

  if (!isValidOccurredAtTimestamp(payload.occurredAt)) {
    throw new UnrecoverableError('Invalid user event occurredAt timestamp');
  }

  const log = deps.logger.child({
    worker: 'user-events',
    source: payload.source,
    eventType: payload.eventType,
    eventId: payload.eventId,
    userId: payload.userId,
  });
  const matchedHandlers = deps.handlers.filter((handler) => handler.matches(payload));
  const matchedHandlerNames = matchedHandlers.map((handler) => handler.name);
  const failures: HandlerFailure[] = [];

  if (matchedHandlers.length === 0) {
    log.info('No user-event handlers matched; dropping job');
    return {
      status: 'skipped_unmatched',
      matchedHandlerNames,
    };
  }

  for (const handler of matchedHandlers) {
    log.debug({ handler: handler.name }, 'Dispatching user-event handler');
    try {
      await handler.handle(payload);
    } catch (error) {
      const normalizedError = normalizeError(error);
      log.error(
        {
          error: normalizedError,
          handler: handler.name,
        },
        'User-event handler failed'
      );
      failures.push({
        handlerName: handler.name,
        error: normalizedError,
      });
    }
  }

  if (failures.length === 1) {
    const firstFailure = failures[0];
    if (firstFailure !== undefined) {
      throw firstFailure.error;
    }
  }

  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `${String(failures.length)} user-event handlers failed: ${failures
        .map((failure) => failure.handlerName)
        .join(', ')}`
    );
  }

  log.info({ matchedHandlerNames }, 'Processed user event job');

  return {
    status: 'handled',
    matchedHandlerNames,
  };
};

export const createUserEventWorker = (
  deps: CreateUserEventWorkerDeps
): Worker<UserEventJobPayload> => {
  const { redis, bullmqPrefix, concurrency = 5, logger, handlers } = deps;

  return new Worker<UserEventJobPayload>(
    QUEUE_NAMES.USER_EVENTS,
    async (job) => {
      return processUserEventJob(
        {
          handlers,
          logger,
        },
        job.data
      );
    },
    {
      connection: redis,
      prefix: bullmqPrefix,
      concurrency,
    }
  );
};
