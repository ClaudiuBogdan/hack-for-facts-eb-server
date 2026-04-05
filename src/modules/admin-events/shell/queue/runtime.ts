import { makeQueueClient, QUEUE_NAMES } from '@/infra/queue/client.js';
import { closeRedis } from '@/infra/queue/close-redis.js';
import { connectQueueRedis, type QueueRedisFactory } from '@/infra/queue/connect-redis.js';

import { makeBullmqAdminEventQueue } from './queue.js';

import type { AdminEventQueuePort } from '../../core/ports.js';
import type { AdminEventJobEnvelope } from '../../core/types.js';
import type { Logger } from 'pino';

export interface AdminEventRuntimeConfig {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  logger: Logger;
  redisFactory?: QueueRedisFactory;
}

export interface AdminEventRuntime {
  queue: AdminEventQueuePort;
  stop(): Promise<void>;
}

export type AdminEventRuntimeFactory = (
  config: AdminEventRuntimeConfig
) => Promise<AdminEventRuntime>;

export const startAdminEventRuntime: AdminEventRuntimeFactory = async (config) => {
  const { redisUrl, redisPassword, bullmqPrefix, logger, redisFactory } = config;
  const log = logger.child({ runtime: 'admin-events' });
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
  const bullmqQueue = queueClient.getQueue<AdminEventJobEnvelope>(QUEUE_NAMES.ADMIN_EVENTS);
  const queue = makeBullmqAdminEventQueue({ queue: bullmqQueue });
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    log.info('Stopping admin event runtime');
    await queueClient.close();
    await closeRedis(redis, log);
    log.info('Admin event runtime stopped');
  };

  return {
    queue,
    stop,
  };
};
