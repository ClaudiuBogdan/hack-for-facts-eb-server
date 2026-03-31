/**
 * Recovery Worker
 *
 * Recovers deliveries that have been stuck in the sending state for too long.
 */

import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError, Worker, type Queue } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { getErrorMessage, isRetryableError } from '../../../core/errors.js';
import { RecoveryJobPayloadSchema } from '../../../core/schemas.js';
import {
  recoverStuckSending,
  type RecoverStuckSendingResult,
} from '../../../core/usecases/recover-stuck-sending.js';
import { enqueueOutboxComposeJob } from '../compose-job-options.js';
import { enqueueSendJob } from '../send-job-options.js';

import type { DeliveryRepository } from '../../../core/ports.js';
import type { ComposeJobPayload, RecoveryJobPayload, SendJobPayload } from '../../../core/types.js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface RecoveryWorkerDeps {
  redis: Redis;
  deliveryRepo: DeliveryRepository;
  composeQueue: Queue<ComposeJobPayload>;
  sendQueue: Queue<SendJobPayload>;
  logger: Logger;
  bullmqPrefix: string;
  concurrency?: number;
}

export const processRecoveryJob = async (
  deps: Pick<RecoveryWorkerDeps, 'deliveryRepo' | 'composeQueue' | 'sendQueue' | 'logger'>,
  payload: unknown
): Promise<RecoverStuckSendingResult> => {
  const { deliveryRepo, composeQueue, sendQueue, logger } = deps;
  const log = logger.child({ worker: 'notification-recovery' });

  if (!Value.Check(RecoveryJobPayloadSchema, payload)) {
    throw new UnrecoverableError('Invalid recovery job payload');
  }

  const jobPayload = payload as RecoveryJobPayload;

  log.info({ thresholdMinutes: jobPayload.thresholdMinutes }, 'Processing recovery job');

  const result = await recoverStuckSending(
    {
      deliveryRepo,
      logger: log,
    },
    {
      thresholdMinutes: jobPayload.thresholdMinutes,
    }
  );

  if (result.isErr()) {
    const message = getErrorMessage(result.error);

    log.error(
      {
        error: result.error,
        thresholdMinutes: jobPayload.thresholdMinutes,
      },
      'Recovery job failed'
    );

    if (isRetryableError(result.error)) {
      throw new Error(message);
    }

    throw new UnrecoverableError(message);
  }

  const recoveryResult = result.value;

  for (const deliveryId of recoveryResult.composeRetryIds) {
    try {
      await enqueueOutboxComposeJob(composeQueue, deliveryId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown compose enqueue error';
      recoveryResult.errors[deliveryId] = message;
      log.error({ deliveryId, error }, 'Failed to enqueue compose retry for recovered delivery');
    }
  }

  for (const deliveryId of recoveryResult.sendRetryIds) {
    try {
      await enqueueSendJob(sendQueue, deliveryId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown send enqueue error';
      recoveryResult.errors[deliveryId] = message;
      log.error({ deliveryId, error }, 'Failed to enqueue send retry for recovered delivery');
    }
  }

  const errorCount = Object.keys(recoveryResult.errors).length;

  if (errorCount > 0) {
    log.warn(
      {
        foundCount: recoveryResult.foundCount,
        recoveredCount: recoveryResult.recoveredCount,
        errorCount,
      },
      'Recovery job completed with partial failures'
    );
  } else {
    log.info(
      {
        foundCount: recoveryResult.foundCount,
        recoveredCount: recoveryResult.recoveredCount,
        errorCount,
      },
      'Recovery job completed'
    );
  }

  return recoveryResult;
};

export const createRecoveryWorker = (deps: RecoveryWorkerDeps): Worker<RecoveryJobPayload> => {
  const {
    redis,
    deliveryRepo,
    composeQueue,
    sendQueue,
    logger,
    bullmqPrefix,
    concurrency = 1,
  } = deps;

  return new Worker<RecoveryJobPayload>(
    QUEUE_NAMES.RECOVERY,
    async (job) => processRecoveryJob({ deliveryRepo, composeQueue, sendQueue, logger }, job.data),
    {
      connection: redis,
      prefix: bullmqPrefix,
      concurrency,
    }
  );
};
