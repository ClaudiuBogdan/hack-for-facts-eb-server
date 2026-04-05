import { UnrecoverableError, Worker } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import {
  recoverPlatformSendSuccessConfirmation,
  type PlatformSendSuccessEvidenceLookup,
  type RecoverPlatformSendSuccessConfirmationInput,
} from '../../../core/usecases/recover-platform-send-success-confirmation.js';

import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../../../core/ports.js';
import type { PlatformSendRecoveryJobPayload } from '../recovery-types.js';
import type {
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface CorrespondenceRecoveryWorkerDeps {
  redis: Redis;
  repo: InstitutionCorrespondenceRepository;
  evidenceLookup: PlatformSendSuccessEvidenceLookup;
  notificationsRepo: Pick<ExtendedNotificationsRepository, 'findActiveByType'>;
  deliveryRepo: Pick<DeliveryRepository, 'findByDeliveryKey'>;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
  logger: Logger;
  bullmqPrefix: string;
}

export const processCorrespondenceRecoveryJob = async (
  deps: Pick<
    CorrespondenceRecoveryWorkerDeps,
    'repo' | 'evidenceLookup' | 'notificationsRepo' | 'deliveryRepo' | 'updatePublisher' | 'logger'
  >,
  payload: RecoverPlatformSendSuccessConfirmationInput
) => {
  const result = await recoverPlatformSendSuccessConfirmation(
    {
      repo: deps.repo,
      evidenceLookup: deps.evidenceLookup,
      notificationsRepo: deps.notificationsRepo,
      deliveryRepo: deps.deliveryRepo,
      ...(deps.updatePublisher !== undefined ? { updatePublisher: deps.updatePublisher } : {}),
    },
    payload
  );

  if (result.isErr()) {
    throw new Error(result.error.message);
  }

  deps.logger.info(
    {
      worker: 'correspondence-recovery',
      foundCount: result.value.foundCount,
      reconciledCount: result.value.reconciledCount,
      publishedCount: result.value.publishedCount,
      pendingConfirmationCount: result.value.pendingConfirmationThreadKeys.length,
      snapshotEntityCount: result.value.snapshotEntityCount,
      snapshotDerivedCount: result.value.snapshotDerivedCount,
      snapshotPublishedCount: result.value.snapshotPublishedCount,
      snapshotAlreadyMaterializedCount: result.value.snapshotAlreadyMaterializedCount,
      snapshotSkippedCount: result.value.snapshotSkippedCount,
      errorCount: Object.keys(result.value.errors).length,
    },
    'Correspondence recovery job completed'
  );

  if (result.value.pendingConfirmationThreadKeys.length > 0) {
    deps.logger.warn(
      {
        worker: 'correspondence-recovery',
        pendingConfirmationThreadKeys: result.value.pendingConfirmationThreadKeys,
      },
      'Platform-send threads still need thread_started confirmation retry'
    );
  }

  return result.value;
};

export const createCorrespondenceRecoveryWorker = (
  deps: CorrespondenceRecoveryWorkerDeps
): Worker<PlatformSendRecoveryJobPayload> => {
  const {
    redis,
    repo,
    evidenceLookup,
    notificationsRepo,
    deliveryRepo,
    updatePublisher,
    logger,
    bullmqPrefix,
  } = deps;

  return new Worker<PlatformSendRecoveryJobPayload>(
    QUEUE_NAMES.CORRESPONDENCE_RECOVERY,
    async (job) => {
      if (typeof job.data.thresholdMinutes !== 'number') {
        throw new UnrecoverableError('Invalid correspondence recovery job payload');
      }

      return processCorrespondenceRecoveryJob(
        {
          repo,
          evidenceLookup,
          notificationsRepo,
          deliveryRepo,
          ...(updatePublisher !== undefined ? { updatePublisher } : {}),
          logger,
        },
        job.data
      );
    },
    {
      connection: redis,
      prefix: bullmqPrefix,
    }
  );
};
