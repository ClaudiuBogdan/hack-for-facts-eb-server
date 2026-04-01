import { makeQueueClient, QUEUE_NAMES } from '@/infra/queue/client.js';
import { closeRedis } from '@/infra/queue/close-redis.js';
import { connectQueueRedis, type QueueRedisFactory } from '@/infra/queue/connect-redis.js';

import { makeUserEventPublisher } from './publisher.js';
import { createUserEventWorker } from './worker.js';

import type { UserEventHandler, UserEventPublisher } from '../../core/ports.js';
import type { UserEventJobPayload } from '../../core/types.js';
import type { Worker } from 'bullmq';
import type { Logger } from 'pino';

export interface UserEventRuntimeConfig {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  logger: Logger;
  concurrency?: number;
  handlers?: readonly UserEventHandler[];
  redisFactory?: QueueRedisFactory;
}

export interface UserEventRuntime {
  publisher: UserEventPublisher;
  stop(): Promise<void>;
}

export type UserEventRuntimeFactory = (config: UserEventRuntimeConfig) => Promise<UserEventRuntime>;

export const startUserEventRuntime: UserEventRuntimeFactory = async (config) => {
  const {
    redisUrl,
    redisPassword,
    bullmqPrefix,
    logger,
    concurrency = 5,
    handlers = [],
    redisFactory,
  } = config;
  const log = logger.child({ runtime: 'user-events' });
  const redis = await connectQueueRedis({
    redisUrl,
    logger: log,
    ...(redisPassword !== undefined ? { redisPassword } : {}),
    ...(redisFactory !== undefined ? { redisFactory } : {}),
  });
  const queueClient = makeQueueClient({
    redis,
    prefix: bullmqPrefix,
    logger,
  });
  const userEventQueue = queueClient.getQueue<UserEventJobPayload>(QUEUE_NAMES.USER_EVENTS);
  const publisher = makeUserEventPublisher({ userEventQueue });
  let worker: Worker<UserEventJobPayload> | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    log.info('Stopping user event runtime');

    if (worker !== undefined) {
      await worker.close();
    }

    await queueClient.close();
    await closeRedis(redis, log);
    log.info('User event runtime stopped');
  };

  try {
    if (handlers.length > 0) {
      worker = createUserEventWorker({
        redis,
        logger,
        handlers,
        bullmqPrefix,
        concurrency,
      });
    }

    return {
      publisher,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
