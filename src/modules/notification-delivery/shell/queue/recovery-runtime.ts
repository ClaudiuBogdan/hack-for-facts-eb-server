import { makeQueueClient, QUEUE_NAMES } from '@/infra/queue/client.js';
import { closeRedis } from '@/infra/queue/close-redis.js';
import { connectQueueRedis, type QueueRedisFactory } from '@/infra/queue/connect-redis.js';

import { registerRecoveryJobScheduler } from './recovery-job-scheduler.js';
import { createWorkerManager } from './worker-manager.js';
import { createRecoveryWorker } from './workers/recovery-worker.js';

import type { DeliveryRepository } from '../../core/ports.js';
import type { ComposeJobPayload, RecoveryJobPayload, SendJobPayload } from '../../core/types.js';
import type { Logger } from 'pino';

export interface NotificationRecoveryRuntimeConfig {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  deliveryRepo: DeliveryRepository;
  logger: Logger;
  intervalMinutes: number;
  thresholdMinutes: number;
  redisFactory?: QueueRedisFactory;
}

export interface NotificationRecoveryRuntime {
  stop(): Promise<void>;
}

export type NotificationRecoveryRuntimeFactory = (
  config: NotificationRecoveryRuntimeConfig
) => Promise<NotificationRecoveryRuntime>;

export const startNotificationRecoveryRuntime: NotificationRecoveryRuntimeFactory = async (
  config
) => {
  const {
    redisUrl,
    redisPassword,
    bullmqPrefix,
    deliveryRepo,
    logger,
    intervalMinutes,
    thresholdMinutes,
    redisFactory,
  } = config;
  const log = logger.child({ runtime: 'notification-recovery' });
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
  const workerManager = createWorkerManager({ logger });
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;

    log.info('Stopping notification recovery runtime');
    await workerManager.stopAll();
    await queueClient.close();
    await closeRedis(redis, log);
    log.info('Notification recovery runtime stopped');
  };

  try {
    const composeQueue = queueClient.getQueue<ComposeJobPayload>(QUEUE_NAMES.COMPOSE);
    const recoveryQueue = queueClient.getQueue<RecoveryJobPayload>(QUEUE_NAMES.RECOVERY);
    const sendQueue = queueClient.getQueue<SendJobPayload>(QUEUE_NAMES.SEND);

    await registerRecoveryJobScheduler({
      recoveryQueue,
      intervalMinutes,
      thresholdMinutes,
    });

    const recoveryWorker = createRecoveryWorker({
      redis,
      deliveryRepo,
      composeQueue,
      sendQueue,
      logger,
      bullmqPrefix,
    });

    workerManager.register(QUEUE_NAMES.RECOVERY, recoveryWorker);

    log.info(
      {
        intervalMinutes,
        thresholdMinutes,
        queueName: QUEUE_NAMES.RECOVERY,
      },
      'Notification recovery runtime started'
    );

    return {
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
