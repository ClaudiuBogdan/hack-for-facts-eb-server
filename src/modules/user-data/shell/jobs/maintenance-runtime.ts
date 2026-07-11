import { makeQueueClient, QUEUE_NAMES, type QueueClient } from '@/infra/queue/client.js';
import { closeRedis } from '@/infra/queue/close-redis.js';
import { connectQueueRedis, type QueueRedisFactory } from '@/infra/queue/connect-redis.js';

import {
  type Clock,
  type UserDataMutationPort,
  type UserDataReconciliationPort,
} from '../../core/ports.js';
import { type ReconciliationReport } from '../../core/types.js';
import { cleanupReceipts } from '../../core/usecases/cleanup-receipts.js';
import { reconcileStore } from '../../core/usecases/reconcile-store.js';
import { type LoggerPort } from '../../core/usecases/shared.js';

import type { Logger } from 'pino';

const RECONCILIATION_LIMIT = 1_000;

export interface UserDataMaintenanceConfig {
  receiptCleanupCron: string;
  reconcileMinutes: number;
}

export interface UserDataMaintenanceRuntime {
  stop(): Promise<void>;
}

export interface UserDataMaintenanceRuntimeOptions {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  mutationPort: UserDataMutationPort;
  reconciliationPort: UserDataReconciliationPort;
  clock: Clock;
  logger: Logger;
  config: UserDataMaintenanceConfig;
  queueClient?: QueueClient;
  redisFactory?: QueueRedisFactory;
}

export type UserDataMaintenanceRuntimeFactory = (
  options: UserDataMaintenanceRuntimeOptions
) => Promise<UserDataMaintenanceRuntime>;

export interface ReceiptCleanupHandlerDeps {
  mutationPort: UserDataMutationPort;
  clock: Clock;
  logger: LoggerPort;
}

export interface ReconciliationHandlerDeps {
  reconciliationPort: UserDataReconciliationPort;
  logger: LoggerPort;
  limit?: number;
}

export const processUserDataReceiptCleanup = async (
  deps: ReceiptCleanupHandlerDeps
): Promise<number | null> => {
  const result = await cleanupReceipts(
    { mutationPort: deps.mutationPort, logger: deps.logger },
    { now: deps.clock.now() }
  );
  if (result.isErr()) {
    deps.logger.error('User Data Store receipt cleanup failed', { errorType: result.error.type });
    return null;
  }
  deps.logger.info('User Data Store receipt cleanup completed', { deletedReceipts: result.value });
  return result.value;
};

export const processUserDataReconciliation = async (
  deps: ReconciliationHandlerDeps
): Promise<ReconciliationReport | null> => {
  const result = await reconcileStore(
    { reconciliationPort: deps.reconciliationPort, logger: deps.logger },
    { limit: deps.limit ?? RECONCILIATION_LIMIT }
  );
  if (result.isErr()) {
    deps.logger.error('User Data Store reconciliation failed', { errorType: result.error.type });
    return null;
  }
  if (result.value.violations.length > 0) {
    deps.logger.error('User Data Store reconciliation found violations', {
      checkedRecords: result.value.checkedRecords,
      violationCount: result.value.violations.length,
      recordIds: [...new Set(result.value.violations.map((entry) => entry.recordId))],
    });
  }
  return result.value;
};

const toLoggerPort = (logger: Logger): LoggerPort => ({
  debug(message, context) {
    if (context === undefined) logger.debug(message);
    else logger.debug(context, message);
  },
  info(message, context) {
    if (context === undefined) logger.info(message);
    else logger.info(context, message);
  },
  warn(message, context) {
    if (context === undefined) logger.warn(message);
    else logger.warn(context, message);
  },
  error(message, context) {
    if (context === undefined) logger.error(message);
    else logger.error(context, message);
  },
});

export const makeUserDataMaintenanceRuntime: UserDataMaintenanceRuntimeFactory = async (
  options
) => {
  const log = options.logger.child({ runtime: 'user-data-maintenance' });
  const coreLogger = toLoggerPort(log);
  const redis =
    options.queueClient === undefined
      ? await connectQueueRedis({
          redisUrl: options.redisUrl,
          logger: log,
          ...(options.redisPassword === undefined ? {} : { redisPassword: options.redisPassword }),
          ...(options.redisFactory === undefined ? {} : { redisFactory: options.redisFactory }),
        })
      : undefined;
  if (options.queueClient === undefined && redis === undefined) {
    throw new Error('User Data Store maintenance runtime requires a queue client or Redis');
  }
  const queueClient =
    options.queueClient ??
    makeQueueClient({
      redis: redis as NonNullable<typeof redis>,
      prefix: options.bullmqPrefix,
      logger: options.logger,
    });
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await queueClient.close();
    } finally {
      if (redis !== undefined) await closeRedis(redis, log);
    }
  };

  try {
    const cleanupQueue = queueClient.getQueue(QUEUE_NAMES.UD_RECEIPT_CLEANUP);
    const reconcileQueue = queueClient.getQueue(QUEUE_NAMES.UD_RECONCILE);
    await cleanupQueue.upsertJobScheduler(
      'ud-receipt-cleanup',
      { pattern: options.config.receiptCleanupCron },
      { name: 'cleanup-receipts', data: {} }
    );
    await reconcileQueue.upsertJobScheduler(
      'ud-reconcile',
      { every: options.config.reconcileMinutes * 60 * 1000 },
      { name: 'reconcile-store', data: {} }
    );
    queueClient.createWorker({
      name: QUEUE_NAMES.UD_RECEIPT_CLEANUP,
      processor: async () =>
        processUserDataReceiptCleanup({
          mutationPort: options.mutationPort,
          clock: options.clock,
          logger: coreLogger,
        }),
    });
    queueClient.createWorker({
      name: QUEUE_NAMES.UD_RECONCILE,
      processor: async () =>
        processUserDataReconciliation({
          reconciliationPort: options.reconciliationPort,
          logger: coreLogger,
        }),
    });
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
