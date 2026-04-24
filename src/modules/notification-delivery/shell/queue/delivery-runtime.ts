import { makeQueueClient, QUEUE_NAMES } from '@/infra/queue/client.js';
import { closeRedis } from '@/infra/queue/close-redis.js';
import { connectQueueRedis, type QueueRedisFactory } from '@/infra/queue/connect-redis.js';

import { makeComposeJobScheduler } from './compose-job-scheduler.js';
import { registerRecoveryJobScheduler } from './recovery-job-scheduler.js';
import { createWorkerManager } from './worker-manager.js';
import { createCollectWorker } from './workers/collect-worker.js';
import { createComposeWorker } from './workers/compose-worker.js';
import { createRecoveryWorker } from './workers/recovery-worker.js';
import { createSendWorker } from './workers/send-worker.js';

import type {
  ComposeJobScheduler,
  DataFetcher,
  DeliveryRepository,
  EmailSenderPort,
  ExtendedNotificationsRepository,
  UserEmailFetcher,
  WeeklyProgressDigestPostSendReconciler,
} from '../../core/ports.js';
import type {
  CollectJobPayload,
  ComposeJobPayload,
  RecoveryJobPayload,
  SendJobPayload,
} from '../../core/types.js';
import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import type { EmailRenderer } from '@/modules/email-templates/index.js';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

export interface NotificationDeliveryWorkerDeps {
  deliveryRepo: DeliveryRepository;
  notificationsRepo: ExtendedNotificationsRepository;
  userEmailFetcher: UserEmailFetcher;
  emailSender: EmailSenderPort;
  tokenSigner: UnsubscribeTokenSigner;
  dataFetcher: DataFetcher;
  emailRenderer: EmailRenderer;
  platformBaseUrl: string;
  apiBaseUrl: string;
  environment: string;
  weeklyProgressDigestPostSendReconciler?: WeeklyProgressDigestPostSendReconciler;
  maxSendRps?: number;
}

export interface NotificationDeliveryRuntimeConfig {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  logger: Logger;
  concurrency?: number;
  intervalMinutes: number;
  thresholdMinutes: number;
  workerDeps?: NotificationDeliveryWorkerDeps;
  redisFactory?: QueueRedisFactory;
}

export interface NotificationDeliveryRuntime {
  collectQueue: Queue<CollectJobPayload>;
  composeJobScheduler: ComposeJobScheduler;
  stop(): Promise<void>;
}

export type NotificationDeliveryRuntimeFactory = (
  config: NotificationDeliveryRuntimeConfig
) => Promise<NotificationDeliveryRuntime>;

export const startNotificationDeliveryRuntime: NotificationDeliveryRuntimeFactory = async (
  config
) => {
  const {
    redisUrl,
    redisPassword,
    bullmqPrefix,
    logger,
    concurrency = 5,
    intervalMinutes,
    thresholdMinutes,
    workerDeps,
    redisFactory,
  } = config;
  const log = logger.child({ runtime: 'notification-delivery' });
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
  const collectQueue = queueClient.getQueue<CollectJobPayload>(QUEUE_NAMES.COLLECT);
  const composeQueue = queueClient.getQueue<ComposeJobPayload>(QUEUE_NAMES.COMPOSE);
  const sendQueue = queueClient.getQueue<SendJobPayload>(QUEUE_NAMES.SEND);
  const recoveryQueue = queueClient.getQueue<RecoveryJobPayload>(QUEUE_NAMES.RECOVERY);
  const composeJobScheduler = makeComposeJobScheduler({ composeQueue });
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;

    log.info('Stopping notification delivery runtime');
    await workerManager.stopAll();
    await queueClient.close();
    await closeRedis(redis, log);
    log.info('Notification delivery runtime stopped');
  };

  try {
    if (workerDeps !== undefined) {
      await registerRecoveryJobScheduler({
        recoveryQueue,
        intervalMinutes,
        thresholdMinutes,
      });

      workerManager.register(
        QUEUE_NAMES.COLLECT,
        createCollectWorker({
          redis,
          composeQueue,
          logger,
          bullmqPrefix,
          concurrency,
        })
      );
      workerManager.register(
        QUEUE_NAMES.COMPOSE,
        createComposeWorker({
          redis,
          sendQueue,
          deliveryRepo: workerDeps.deliveryRepo,
          notificationsRepo: workerDeps.notificationsRepo,
          tokenSigner: workerDeps.tokenSigner,
          dataFetcher: workerDeps.dataFetcher,
          emailRenderer: workerDeps.emailRenderer,
          logger,
          platformBaseUrl: workerDeps.platformBaseUrl,
          apiBaseUrl: workerDeps.apiBaseUrl,
          bullmqPrefix,
          concurrency,
        })
      );
      workerManager.register(
        QUEUE_NAMES.SEND,
        createSendWorker({
          redis,
          deliveryRepo: workerDeps.deliveryRepo,
          notificationsRepo: workerDeps.notificationsRepo,
          userEmailFetcher: workerDeps.userEmailFetcher,
          emailSender: workerDeps.emailSender,
          tokenSigner: workerDeps.tokenSigner,
          logger,
          apiBaseUrl: workerDeps.apiBaseUrl,
          environment: workerDeps.environment,
          ...(workerDeps.weeklyProgressDigestPostSendReconciler !== undefined
            ? {
                weeklyProgressDigestPostSendReconciler:
                  workerDeps.weeklyProgressDigestPostSendReconciler,
              }
            : {}),
          composeJobScheduler,
          bullmqPrefix,
          concurrency,
          ...(workerDeps.maxSendRps !== undefined ? { maxRps: workerDeps.maxSendRps } : {}),
        })
      );
      workerManager.register(
        QUEUE_NAMES.RECOVERY,
        createRecoveryWorker({
          redis,
          deliveryRepo: workerDeps.deliveryRepo,
          composeQueue,
          sendQueue,
          logger,
          bullmqPrefix,
        })
      );
    }

    return {
      collectQueue,
      composeJobScheduler,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
