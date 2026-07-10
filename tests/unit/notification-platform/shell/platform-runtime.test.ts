import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES, type CreateWorkerOptions, type QueueClient } from '@/infra/queue/client.js';
import {
  startNotificationPlatformRuntime,
  type NotificationPlatformRuntimeConfig,
  type NotificationPlatformRuntimeFactories,
  type NotificationPlatformWorkerDeps,
} from '@/modules/notification-platform/shell/queue/platform-runtime.js';

import { makeUsecaseHarness } from '../usecases/harness.js';

import type { QueueRedis } from '@/infra/queue/connect-redis.js';
import type { WorkerManager } from '@/modules/notification-delivery/index.js';
import type { RetentionRunner } from '@/modules/notification-platform/shell/retention/apply-retention.js';
import type { Queue, Worker } from 'bullmq';

const logger = pinoLogger({ level: 'silent' });

const makeWorkerDeps = (): NotificationPlatformWorkerDeps => {
  const h = makeUsecaseHarness();
  const retention: RetentionRunner = {
    applyRetention: async () =>
      ok({
        deliveryAttemptsDeleted: 0,
        providerWebhooksDeleted: 0,
        digestMembersDeleted: 0,
        deliveriesDeleted: 0,
        digestBatchesDeleted: 0,
        logicalNotificationsDeleted: 0,
        eventsRedacted: 0,
        eventsDeleted: 0,
      }),
  };

  return {
    events: h.events,
    watermarks: h.watermarks,
    subscriptions: h.subscriptions,
    preferences: h.preferences,
    anonymization: h.anonymization,
    logicalNotifications: h.logicalNotifications,
    deliveries: h.deliveries,
    attempts: h.attempts,
    destinations: h.destinations,
    digests: h.digests,
    audit: h.audit,
    registry: h.registry,
    channelAdapters: h.channelAdapters,
    eventSources: [],
    retention,
    clock: h.clock,
    ids: h.ids,
    maxSendRps: 4,
  };
};

const makeRuntimeStubs = (options: { failRenderConstruction?: boolean } = {}) => {
  const lifecycle: string[] = [];
  const registered: string[] = [];
  const scheduled: string[] = [];
  const redis = {} as QueueRedis;
  const worker = {
    on: () => worker,
    close: async () => undefined,
  } as unknown as Worker;
  const queue = {
    add: async () => undefined as never,
    upsertJobScheduler: async (id: string) => {
      scheduled.push(id);
      return undefined as never;
    },
  } as unknown as Queue;
  const queueClient: QueueClient = {
    getQueue: <T>() => queue as Queue<T>,
    createWorker: <T>(_options: CreateWorkerOptions<T>) => worker as Worker<T>,
    close: async () => {
      lifecycle.push('queues');
    },
  };
  const workerManager: WorkerManager = {
    register: (name) => {
      registered.push(name);
    },
    registerAll: (workers) => {
      registered.push(...Object.keys(workers));
    },
    stopAll: async () => {
      lifecycle.push('workers');
    },
    getWorker: () => undefined,
    getWorkerNames: () => [...registered],
  };

  const factories = {
    connectRedis: async () => redis,
    makeQueueClient: () => queueClient,
    createWorkerManager: () => workerManager,
    closeRedis: async () => {
      lifecycle.push('redis');
    },
    createIngestionScanWorker: () =>
      worker as ReturnType<NotificationPlatformRuntimeFactories['createIngestionScanWorker']>,
    createFanOutWorker: () =>
      worker as ReturnType<NotificationPlatformRuntimeFactories['createFanOutWorker']>,
    createRenderWorker: () => {
      if (options.failRenderConstruction === true) {
        throw new Error('render worker construction failed');
      }
      return worker as ReturnType<NotificationPlatformRuntimeFactories['createRenderWorker']>;
    },
    createSendWorker: () =>
      worker as ReturnType<NotificationPlatformRuntimeFactories['createSendWorker']>,
    createDigestWorker: () =>
      worker as ReturnType<NotificationPlatformRuntimeFactories['createDigestWorker']>,
    createRecoveryWorker: () =>
      worker as ReturnType<NotificationPlatformRuntimeFactories['createRecoveryWorker']>,
    createRetentionWorker: () =>
      worker as ReturnType<NotificationPlatformRuntimeFactories['createRetentionWorker']>,
  } satisfies NotificationPlatformRuntimeFactories;

  return { factories, lifecycle, registered, scheduled };
};

const makeConfig = (
  factories: NotificationPlatformRuntimeFactories,
  workerDeps?: NotificationPlatformWorkerDeps
): NotificationPlatformRuntimeConfig => ({
  redisUrl: 'redis://runtime.test:6379',
  bullmqPrefix: 'runtime-test',
  logger,
  ingestionScanIntervalSeconds: 60,
  recoveryScanIntervalMinutes: 2,
  digestSweepIntervalMinutes: 5,
  recoveryThresholdMinutes: 10,
  factories,
  ...(workerDeps === undefined ? {} : { workerDeps }),
});

describe('startNotificationPlatformRuntime', () => {
  it('runs in producer-only mode without repeatable schedulers or workers', async () => {
    const stubs = makeRuntimeStubs();
    const runtime = await startNotificationPlatformRuntime(makeConfig(stubs.factories));

    expect(stubs.registered).toEqual([]);
    expect(stubs.scheduled).toEqual([]);

    await runtime.stop();
  });

  it('stops workers before queues and Redis', async () => {
    const stubs = makeRuntimeStubs();
    const runtime = await startNotificationPlatformRuntime(
      makeConfig(stubs.factories, makeWorkerDeps())
    );

    expect(stubs.registered).toEqual([
      QUEUE_NAMES.NP_INGESTION,
      QUEUE_NAMES.NP_FANOUT,
      QUEUE_NAMES.NP_RENDER,
      QUEUE_NAMES.NP_SEND,
      QUEUE_NAMES.NP_DIGEST,
      QUEUE_NAMES.NP_RECOVERY,
      QUEUE_NAMES.NP_RETENTION,
    ]);
    await runtime.stop();
    expect(stubs.lifecycle).toEqual(['workers', 'queues', 'redis']);
  });

  it('cleans up constructed resources when worker construction fails', async () => {
    const stubs = makeRuntimeStubs({ failRenderConstruction: true });

    await expect(
      startNotificationPlatformRuntime(makeConfig(stubs.factories, makeWorkerDeps()))
    ).rejects.toThrow('render worker construction failed');
    expect(stubs.lifecycle).toEqual(['workers', 'queues', 'redis']);
  });
});
