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
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface CorrespondenceRecoveryWorkerDeps {
  redis: Redis;
  repo: InstitutionCorrespondenceRepository;
  evidenceLookup: PlatformSendSuccessEvidenceLookup;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
  logger: Logger;
  bullmqPrefix: string;
}

export const processCorrespondenceRecoveryJob = async (
  deps: Pick<
    CorrespondenceRecoveryWorkerDeps,
    'repo' | 'evidenceLookup' | 'updatePublisher' | 'logger'
  >,
  payload: RecoverPlatformSendSuccessConfirmationInput
) => {
  const result = await recoverPlatformSendSuccessConfirmation(
    {
      repo: deps.repo,
      evidenceLookup: deps.evidenceLookup,
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
  const { redis, repo, evidenceLookup, updatePublisher, logger, bullmqPrefix } = deps;

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
