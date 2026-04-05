import { makeQueueClient, QUEUE_NAMES } from '@/infra/queue/client.js';
import { closeRedis } from '@/infra/queue/close-redis.js';
import { connectQueueRedis, type QueueRedisFactory } from '@/infra/queue/connect-redis.js';

import { registerCorrespondenceRecoveryJobScheduler } from './recovery-job-scheduler.js';
import { createCorrespondenceRecoveryWorker } from './workers/recovery-worker.js';

import type { PlatformSendRecoveryJobPayload } from './recovery-types.js';
import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../../core/ports.js';
import type { PlatformSendSuccessEvidenceLookup } from '../../core/usecases/recover-platform-send-success-confirmation.js';
import type {
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';
import type { Logger } from 'pino';

export interface CorrespondenceRecoveryRuntimeConfig {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  repo: InstitutionCorrespondenceRepository;
  evidenceLookup: PlatformSendSuccessEvidenceLookup;
  notificationsRepo: Pick<ExtendedNotificationsRepository, 'findActiveByType'>;
  deliveryRepo: Pick<DeliveryRepository, 'findByDeliveryKey'>;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
  logger: Logger;
  intervalMinutes: number;
  thresholdMinutes: number;
  redisFactory?: QueueRedisFactory;
}

export interface CorrespondenceRecoveryRuntime {
  stop(): Promise<void>;
}

export type CorrespondenceRecoveryRuntimeFactory = (
  config: CorrespondenceRecoveryRuntimeConfig
) => Promise<CorrespondenceRecoveryRuntime>;

export const startCorrespondenceRecoveryRuntime: CorrespondenceRecoveryRuntimeFactory = async (
  config
) => {
  const {
    redisUrl,
    redisPassword,
    bullmqPrefix,
    repo,
    evidenceLookup,
    notificationsRepo,
    deliveryRepo,
    updatePublisher,
    logger,
    intervalMinutes,
    thresholdMinutes,
    redisFactory,
  } = config;
  const log = logger.child({ runtime: 'correspondence-recovery' });
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
  const recoveryQueue = queueClient.getQueue<PlatformSendRecoveryJobPayload>(
    QUEUE_NAMES.CORRESPONDENCE_RECOVERY
  );
  const worker = createCorrespondenceRecoveryWorker({
    redis,
    repo,
    evidenceLookup,
    notificationsRepo,
    deliveryRepo,
    ...(updatePublisher !== undefined ? { updatePublisher } : {}),
    logger,
    bullmqPrefix,
  });
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;

    log.info('Stopping correspondence recovery runtime');
    await worker.close();
    await queueClient.close();
    await closeRedis(redis, log);
    log.info('Correspondence recovery runtime stopped');
  };

  try {
    await registerCorrespondenceRecoveryJobScheduler({
      recoveryQueue,
      intervalMinutes,
      thresholdMinutes,
    });

    log.info(
      {
        intervalMinutes,
        thresholdMinutes,
        queueName: QUEUE_NAMES.CORRESPONDENCE_RECOVERY,
      },
      'Correspondence recovery runtime started'
    );

    return {
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
