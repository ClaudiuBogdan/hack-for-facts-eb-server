import { makeQueueClient, QUEUE_NAMES, type QueueClient } from '@/infra/queue/client.js';
import { closeRedis } from '@/infra/queue/close-redis.js';
import { connectQueueRedis, type QueueRedisFactory } from '@/infra/queue/connect-redis.js';
import { createWorkerManager, type WorkerManager } from '@/modules/notification-delivery/index.js';

import {
  makeDigestMaterializeScheduler,
  makeEventFanOutScheduler,
  makeRenderJobScheduler,
  makeSendJobScheduler,
  registerDigestSweepScheduler,
  registerIngestionScanSchedulers,
  registerPlatformRecoveryScheduler,
  registerRetentionScheduler,
  type PlatformRecoveryJobPayload,
  type RetentionJobPayload,
} from './schedulers.js';
import { createDigestWorker } from './workers/digest-worker.js';
import { createFanOutWorker } from './workers/fanout-worker.js';
import { createIngestionScanWorker } from './workers/ingestion-scan-worker.js';
import { createRecoveryWorker } from './workers/recovery-worker.js';
import { createRenderWorker } from './workers/render-worker.js';
import { createRetentionWorker } from './workers/retention-worker.js';
import { createSendWorker } from './workers/send-worker.js';

import type { AuditLedgerPort } from '../../core/audit/ports.js';
import type {
  AnonymizationCheckPort,
  ChannelAdapterPort,
  ChannelDestinationRepo,
  DeliveryAttemptRepo,
  DeliveryRepo,
  RenderJobScheduler,
  SendJobScheduler,
} from '../../core/delivery/ports.js';
import type { RenderJobPayload, SendJobPayload } from '../../core/delivery/schemas.js';
import type { DigestBatchRepo } from '../../core/digest/ports.js';
import type { DigestMaterializeJobPayload } from '../../core/digest/schemas.js';
import type {
  EventFanOutScheduler,
  EventSourcePort,
  NotificationEventRepo,
  SourceWatermarkRepo,
} from '../../core/events/ports.js';
import type { EventFanOutJobPayload, IngestionScanJobPayload } from '../../core/events/schemas.js';
import type { LogicalNotificationRepo } from '../../core/inbox/ports.js';
import type { PreferenceRepo } from '../../core/preferences/ports.js';
import type { KindRegistry } from '../../core/registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../core/shared/ports.js';
import type { ExternalChannel } from '../../core/shared/types.js';
import type { SubscriptionRepo } from '../../core/subscriptions/ports.js';
import type { RetentionRunner } from '../retention/apply-retention.js';
import type { Logger } from 'pino';

export interface NotificationPlatformWorkerDeps {
  events: NotificationEventRepo;
  watermarks: SourceWatermarkRepo;
  subscriptions: SubscriptionRepo;
  preferences: PreferenceRepo;
  anonymization: AnonymizationCheckPort;
  logicalNotifications: LogicalNotificationRepo;
  deliveries: DeliveryRepo;
  attempts: DeliveryAttemptRepo;
  destinations: ChannelDestinationRepo;
  digests: DigestBatchRepo;
  audit: AuditLedgerPort;
  registry: KindRegistry;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  eventSources: readonly EventSourcePort[];
  retention: RetentionRunner;
  clock: Clock;
  ids: IdGenerator;
  maxSendRps?: number;
}

export interface NotificationPlatformRuntimeConfig {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  logger: Logger;
  concurrency?: number;
  ingestionScanIntervalSeconds: number;
  recoveryScanIntervalMinutes: number;
  digestSweepIntervalMinutes: number;
  recoveryThresholdMinutes: number;
  workerDeps?: NotificationPlatformWorkerDeps;
  redisFactory?: QueueRedisFactory;
  factories?: Partial<NotificationPlatformRuntimeFactories>;
}

export interface NotificationPlatformRuntime {
  fanOutScheduler: EventFanOutScheduler;
  renderScheduler: RenderJobScheduler;
  sendScheduler: SendJobScheduler;
  stop(): Promise<void>;
}

export type NotificationPlatformRuntimeFactory = (
  config: NotificationPlatformRuntimeConfig
) => Promise<NotificationPlatformRuntime>;

export interface NotificationPlatformRuntimeFactories {
  connectRedis: typeof connectQueueRedis;
  makeQueueClient: typeof makeQueueClient;
  createWorkerManager: typeof createWorkerManager;
  closeRedis: typeof closeRedis;
  createIngestionScanWorker: typeof createIngestionScanWorker;
  createFanOutWorker: typeof createFanOutWorker;
  createRenderWorker: typeof createRenderWorker;
  createSendWorker: typeof createSendWorker;
  createDigestWorker: typeof createDigestWorker;
  createRecoveryWorker: typeof createRecoveryWorker;
  createRetentionWorker: typeof createRetentionWorker;
}

const DEFAULT_RUNTIME_FACTORIES: NotificationPlatformRuntimeFactories = {
  connectRedis: connectQueueRedis,
  makeQueueClient,
  createWorkerManager,
  closeRedis,
  createIngestionScanWorker,
  createFanOutWorker,
  createRenderWorker,
  createSendWorker,
  createDigestWorker,
  createRecoveryWorker,
  createRetentionWorker,
};

const toLoggerPort = (logger: Logger): LoggerPort => ({
  child(bindings) {
    return toLoggerPort(logger.child(bindings));
  },
  debug(message, data) {
    if (data === undefined) logger.debug(message);
    else logger.debug(data, message);
  },
  info(message, data) {
    if (data === undefined) logger.info(message);
    else logger.info(data, message);
  },
  warn(message, data) {
    if (data === undefined) logger.warn(message);
    else logger.warn(data, message);
  },
  error(message, data) {
    if (data === undefined) logger.error(message);
    else logger.error(data, message);
  },
});

export const startNotificationPlatformRuntime: NotificationPlatformRuntimeFactory = async (
  config
) => {
  const {
    redisUrl,
    redisPassword,
    bullmqPrefix,
    logger,
    concurrency = 5,
    ingestionScanIntervalSeconds,
    recoveryScanIntervalMinutes,
    digestSweepIntervalMinutes,
    recoveryThresholdMinutes,
    workerDeps,
    redisFactory,
    factories: factoryOverrides,
  } = config;
  const factories: NotificationPlatformRuntimeFactories = {
    ...DEFAULT_RUNTIME_FACTORIES,
    ...factoryOverrides,
  };
  const log = logger.child({ runtime: 'notification-platform' });
  const coreLogger = toLoggerPort(log);
  const redis = await factories.connectRedis({
    redisUrl,
    logger: log,
    ...(redisPassword === undefined ? {} : { redisPassword }),
    ...(redisFactory === undefined ? {} : { redisFactory }),
  });
  let queueClient: QueueClient | undefined;
  let workerManager: WorkerManager | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;

    log.info('Stopping notification platform runtime');
    try {
      await workerManager?.stopAll();
    } finally {
      try {
        await queueClient?.close();
      } finally {
        await factories.closeRedis(redis, log);
      }
    }
    log.info('Notification platform runtime stopped');
  };

  try {
    queueClient = factories.makeQueueClient({ redis, prefix: bullmqPrefix, logger });
    workerManager = factories.createWorkerManager({ logger });
    const ingestionQueue = queueClient.getQueue<IngestionScanJobPayload>(QUEUE_NAMES.NP_INGESTION);
    const fanOutQueue = queueClient.getQueue<EventFanOutJobPayload>(QUEUE_NAMES.NP_FANOUT);
    const renderQueue = queueClient.getQueue<RenderJobPayload>(QUEUE_NAMES.NP_RENDER);
    const sendQueue = queueClient.getQueue<SendJobPayload>(QUEUE_NAMES.NP_SEND);
    const digestQueue = queueClient.getQueue<DigestMaterializeJobPayload>(QUEUE_NAMES.NP_DIGEST);
    const recoveryQueue = queueClient.getQueue<PlatformRecoveryJobPayload>(QUEUE_NAMES.NP_RECOVERY);
    const retentionQueue = queueClient.getQueue<RetentionJobPayload>(QUEUE_NAMES.NP_RETENTION);
    const fanOutScheduler = makeEventFanOutScheduler(fanOutQueue);
    const renderScheduler = makeRenderJobScheduler(renderQueue);
    const sendScheduler = makeSendJobScheduler(sendQueue);
    const digestScheduler = makeDigestMaterializeScheduler(digestQueue);

    if (workerDeps !== undefined) {
      await registerIngestionScanSchedulers(
        ingestionQueue,
        workerDeps.eventSources,
        ingestionScanIntervalSeconds
      );
      await registerPlatformRecoveryScheduler(
        recoveryQueue,
        recoveryScanIntervalMinutes,
        recoveryThresholdMinutes
      );
      await registerDigestSweepScheduler(digestQueue, digestSweepIntervalMinutes);
      await registerRetentionScheduler(retentionQueue);

      const eventSources = new Map(
        workerDeps.eventSources.map((source) => [source.sourceId, source])
      );
      const common = {
        redis,
        bullmqPrefix,
        concurrency,
        clock: workerDeps.clock,
        ids: workerDeps.ids,
        logger: coreLogger,
      };

      workerManager.register(
        QUEUE_NAMES.NP_INGESTION,
        factories.createIngestionScanWorker({
          ...common,
          eventSources,
          watermarks: workerDeps.watermarks,
          events: workerDeps.events,
          registry: workerDeps.registry,
          audit: workerDeps.audit,
          fanOutScheduler,
        })
      );
      workerManager.register(
        QUEUE_NAMES.NP_FANOUT,
        factories.createFanOutWorker({
          ...common,
          events: workerDeps.events,
          registry: workerDeps.registry,
          subscriptions: workerDeps.subscriptions,
          preferences: workerDeps.preferences,
          anonymization: workerDeps.anonymization,
          logicalNotifications: workerDeps.logicalNotifications,
          deliveries: workerDeps.deliveries,
          digests: workerDeps.digests,
          destinations: workerDeps.destinations,
          channelAdapters: workerDeps.channelAdapters,
          renderScheduler,
          audit: workerDeps.audit,
        })
      );
      workerManager.register(
        QUEUE_NAMES.NP_RENDER,
        factories.createRenderWorker({
          ...common,
          deliveries: workerDeps.deliveries,
          digests: workerDeps.digests,
          logicalNotifications: workerDeps.logicalNotifications,
          events: workerDeps.events,
          registry: workerDeps.registry,
          channelAdapters: workerDeps.channelAdapters,
          sendScheduler,
        })
      );
      workerManager.register(
        QUEUE_NAMES.NP_SEND,
        factories.createSendWorker({
          ...common,
          deliveries: workerDeps.deliveries,
          attempts: workerDeps.attempts,
          destinations: workerDeps.destinations,
          preferences: workerDeps.preferences,
          anonymization: workerDeps.anonymization,
          registry: workerDeps.registry,
          channelAdapters: workerDeps.channelAdapters,
          sendScheduler,
          audit: workerDeps.audit,
          maxSendRps: workerDeps.maxSendRps ?? 2,
        })
      );
      workerManager.register(
        QUEUE_NAMES.NP_DIGEST,
        factories.createDigestWorker({
          ...common,
          digests: workerDeps.digests,
          deliveries: workerDeps.deliveries,
          destinations: workerDeps.destinations,
          channelAdapters: workerDeps.channelAdapters,
          renderScheduler,
          audit: workerDeps.audit,
        })
      );
      workerManager.register(
        QUEUE_NAMES.NP_RECOVERY,
        factories.createRecoveryWorker({
          ...common,
          events: workerDeps.events,
          deliveries: workerDeps.deliveries,
          attempts: workerDeps.attempts,
          digests: workerDeps.digests,
          channelAdapters: workerDeps.channelAdapters,
          fanOutScheduler,
          renderScheduler,
          sendScheduler,
          digestScheduler,
          audit: workerDeps.audit,
        })
      );
      workerManager.register(
        QUEUE_NAMES.NP_RETENTION,
        factories.createRetentionWorker({
          ...common,
          retention: workerDeps.retention,
        })
      );
    }

    return { fanOutScheduler, renderScheduler, sendScheduler, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
