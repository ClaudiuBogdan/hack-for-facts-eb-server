import { ok } from 'neverthrow';

import { createApp } from '@/app/build-app.js';
import { QUEUE_NAMES } from '@/infra/queue/client.js';
import { createTestAuthProvider } from '@/modules/auth/index.js';
import {
  NOTIFICATION_PLATFORM_ADMIN_PERMISSION,
  makeKindRegistry,
  type NotificationPlatformRuntimeFactory,
  type NotificationPlatformWorkerDeps,
  type PlatformAdminRoutesFactory,
} from '@/modules/notification-platform/index.js';
import { processDigestJob } from '@/modules/notification-platform/shell/queue/workers/digest-worker.js';
import { processFanOutJob } from '@/modules/notification-platform/shell/queue/workers/fanout-worker.js';
import { processRenderJob } from '@/modules/notification-platform/shell/queue/workers/render-worker.js';
import { processSendJob } from '@/modules/notification-platform/shell/queue/workers/send-worker.js';

import { makeTestConfig } from '../../fixtures/builders.js';
import {
  makeFakeBudgetDb,
  makeFakeDatasetRepo,
  makeFakeInsDb,
  makeFakeKyselyDb,
} from '../../fixtures/fakes.js';
import {
  makeFakeAnonymizationCheckPort,
  makeFakeAuditLedgerPort,
  makeFakeChannelAdapterPort,
  makeFakeChannelDestinationRepo,
  makeFakeDeliveryAttemptRepo,
  makeFakeDeliveryRepo,
  makeFakeDigestBatchRepo,
  makeFakeEventFanOutScheduler,
  makeFakeLoggerPort,
  makeFakeLogicalNotificationRepo,
  makeFakeNotificationEventRepo,
  makeFakePreferenceRepo,
  makeFakeRenderJobScheduler,
  makeFakeSendJobScheduler,
  makeFakeSourceWatermarkRepo,
  makeFakeSubjectAuthorizationPort,
  makeFakeSubscriptionRepo,
  makeTestKind,
} from '../../fixtures/notification-platform/index.js';
import { makeInMemoryJobRuntime, makeSequentialIds, makeTestClock } from '../../support/index.js';

import type { FastifyInstance } from 'fastify';

export interface NotificationPlatformIntegrationHarness {
  app: FastifyInstance;
  auth: ReturnType<typeof createTestAuthProvider>;
  clock: ReturnType<typeof makeTestClock>;
  ids: ReturnType<typeof makeSequentialIds>;
  runtime: ReturnType<typeof makeInMemoryJobRuntime>;
  logger: ReturnType<typeof makeFakeLoggerPort>;
  kind: ReturnType<typeof makeTestKind>;
  registry: NotificationPlatformWorkerDeps['registry'];
  events: ReturnType<typeof makeFakeNotificationEventRepo>;
  subscriptions: ReturnType<typeof makeFakeSubscriptionRepo>;
  preferences: ReturnType<typeof makeFakePreferenceRepo>;
  logicalNotifications: ReturnType<typeof makeFakeLogicalNotificationRepo>;
  deliveries: ReturnType<typeof makeFakeDeliveryRepo>;
  attempts: ReturnType<typeof makeFakeDeliveryAttemptRepo>;
  destinations: ReturnType<typeof makeFakeChannelDestinationRepo>;
  digests: ReturnType<typeof makeFakeDigestBatchRepo>;
  audit: ReturnType<typeof makeFakeAuditLedgerPort>;
  anonymization: ReturnType<typeof makeFakeAnonymizationCheckPort>;
  adapter: ReturnType<typeof makeFakeChannelAdapterPort>;
  fanOutScheduler: ReturnType<typeof makeFakeEventFanOutScheduler>;
  renderScheduler: ReturnType<typeof makeFakeRenderJobScheduler>;
  sendScheduler: ReturnType<typeof makeFakeSendJobScheduler>;
  subjectAuthorizer: ReturnType<typeof makeFakeSubjectAuthorizationPort>;
  adminPermissionCalls: { userId: string; permissionName: string }[];
  runtimeStopCount(): number;
}

export const authHeaders = (
  harness: NotificationPlatformIntegrationHarness,
  user: 'user1' | 'user2' = 'user1'
): { authorization: string } => ({
  authorization: `Bearer ${harness.auth.tokens[user]}`,
});

export const makeNotificationPlatformIntegrationHarness = async (
  options: {
    subjectAllowed?: boolean;
    adminPermissions?: Partial<Record<'user1' | 'user2', readonly string[]>>;
    adminRoutesFactory?: PlatformAdminRoutesFactory;
    onRuntimeStop?: () => void;
  } = {}
): Promise<NotificationPlatformIntegrationHarness> => {
  const auth = createTestAuthProvider();
  const clock = makeTestClock(new Date('2026-01-15T10:00:00.000Z'));
  const ids = makeSequentialIds('integration');
  const logger = makeFakeLoggerPort();
  const runtime = makeInMemoryJobRuntime({ clock, ids: makeSequentialIds('job') });
  const kind = makeTestKind();
  const registryResult = makeKindRegistry([kind]);
  if (registryResult.isErr()) {
    throw new Error(registryResult.error.message);
  }

  const events = makeFakeNotificationEventRepo({ clock });
  const subscriptions = makeFakeSubscriptionRepo();
  const preferences = makeFakePreferenceRepo();
  const logicalNotifications = makeFakeLogicalNotificationRepo();
  const eventIdByLogicalId = new Map<string, string>();
  const deliveries = makeFakeDeliveryRepo({ clock, eventIdByLogicalId });
  const attempts = makeFakeDeliveryAttemptRepo();
  const destinations = makeFakeChannelDestinationRepo({ ids });
  const digests = makeFakeDigestBatchRepo({
    clock,
    logicalNotifications: logicalNotifications.store,
    deliveries: deliveries.store,
  });
  const audit = makeFakeAuditLedgerPort({ ids });
  const anonymization = makeFakeAnonymizationCheckPort();
  const adapter = makeFakeChannelAdapterPort();
  const fanOutScheduler = makeFakeEventFanOutScheduler(runtime);
  const renderScheduler = makeFakeRenderJobScheduler(runtime);
  const sendScheduler = makeFakeSendJobScheduler(runtime);
  const subjectAuthorizer = makeFakeSubjectAuthorizationPort({
    allowed: options.subjectAllowed ?? true,
    denyReason: 'Subject access denied by test authorizer',
  });
  const workerDeps: NotificationPlatformWorkerDeps = {
    events,
    watermarks: makeFakeSourceWatermarkRepo(),
    subscriptions,
    preferences,
    anonymization,
    logicalNotifications,
    deliveries,
    attempts,
    destinations,
    digests,
    audit,
    registry: registryResult.value,
    channelAdapters: new Map([['email', adapter] as const]),
    eventSources: [],
    retention: {
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
    },
    clock,
    ids,
    maxSendRps: 10,
  };

  runtime.register<{ eventId: string }>(QUEUE_NAMES.NP_FANOUT, async (job) => {
    await processFanOutJob({ ...workerDeps, renderScheduler, logger }, job.payload);
  });
  runtime.register<{ deliveryId: string }>(QUEUE_NAMES.NP_RENDER, async (job) => {
    await processRenderJob({ ...workerDeps, sendScheduler, logger }, job.payload);
  });
  runtime.register<{ deliveryId: string }>(QUEUE_NAMES.NP_SEND, async (job) => {
    await processSendJob({ ...workerDeps, sendScheduler, logger }, job.payload);
  });
  runtime.register<{ limit: number }>(QUEUE_NAMES.NP_DIGEST, async (job) => {
    await processDigestJob({ ...workerDeps, renderScheduler, logger }, job.payload);
  });

  let runtimeStops = 0;
  const notificationPlatformRuntimeFactory: NotificationPlatformRuntimeFactory = async (config) => {
    if (config.workerDeps !== workerDeps) {
      throw new Error('Integration app did not pass the injected platform worker dependencies');
    }
    return {
      fanOutScheduler,
      renderScheduler,
      sendScheduler,
      stop: async () => {
        runtimeStops += 1;
        options.onRuntimeStop?.();
      },
    };
  };

  const adminPermissionsByUser =
    options.adminPermissions === undefined
      ? new Map<string, ReadonlySet<string>>([
          [auth.userIds.user1, new Set([NOTIFICATION_PLATFORM_ADMIN_PERMISSION])],
        ])
      : new Map<string, ReadonlySet<string>>(
          (['user1', 'user2'] as const).map((user) => [
            auth.userIds[user],
            new Set(options.adminPermissions?.[user] ?? []),
          ])
        );
  const adminPermissionCalls: { userId: string; permissionName: string }[] = [];
  const app = await createApp({
    fastifyOptions: { logger: false },
    deps: {
      budgetDb: makeFakeBudgetDb(),
      insDb: makeFakeInsDb(),
      userDb: makeFakeKyselyDb(),
      datasetRepo: makeFakeDatasetRepo(),
      authProvider: auth.provider,
      notificationDeliveryRuntimeFactory: async () => ({
        collectQueue: {} as never,
        composeJobScheduler: {} as never,
        stop: async () => undefined,
      }),
      userEventRuntimeFactory: async () => ({
        publisher: {
          publish: async () => undefined,
          publishMany: async () => undefined,
        },
        stop: async () => undefined,
      }),
      notificationPlatformRuntimeFactory,
      notificationPlatformOverrides: {
        workerDeps,
        subjectAuthorizers: new Map([[kind.kindId, subjectAuthorizer]]),
        adminPermissionAuthorizer: {
          hasPermission: async (input) => {
            adminPermissionCalls.push(input);
            if (input.permissionName !== NOTIFICATION_PLATFORM_ADMIN_PERMISSION) {
              throw new Error(
                `Unexpected notification platform permission: ${input.permissionName}`
              );
            }
            return adminPermissionsByUser.get(input.userId)?.has(input.permissionName) === true;
          },
        },
        legacyOutboxReader: {
          listComparisonRecipients: async () => ok([]),
        },
        ...(options.adminRoutesFactory === undefined
          ? {}
          : { adminRoutesFactory: options.adminRoutesFactory }),
      },
      config: makeTestConfig({
        jobs: {
          redisUrl: 'redis://notification-platform.test:6379',
          redisPassword: undefined,
          concurrency: 5,
          prefix: 'test:notification-platform',
          notificationRecoverySweepIntervalMinutes: 15,
          notificationStuckSendingThresholdMinutes: 15,
        },
        auth: {
          clerkSecretKey: 'sk_test_notification_platform',
          clerkJwtKey: undefined,
          clerkAuthorizedParties: undefined,
          clerkWebhookSigningSecret: undefined,
          enabled: true,
        },
        email: {
          apiKey: 're_test_notification_platform',
          webhookSecret: undefined,
          fromAddress: 'notifications@test.example.com',
          funkyFromAddress: 'campaign@test.example.com',
          funkyFromAddressCcRecipients: [],
          funkyReplyToAddress: 'reply@test.example.com',
          previewEnabled: false,
          maxRps: 2,
          enabled: false,
        },
        notificationPlatform: {
          enabled: true,
          ingestionScanSeconds: 60,
          recoveryScanMinutes: 2,
          digestSweepMinutes: 5,
          recoveryThresholdMinutes: 10,
          retentionBatchLimit: 500,
          maxSendRps: 10,
          destinationFingerprintSecret: 'fingerprint-secret-for-integration-tests',
        },
      }),
    },
  });

  return {
    app,
    auth,
    clock,
    ids,
    runtime,
    logger,
    kind,
    registry: registryResult.value,
    events,
    subscriptions,
    preferences,
    logicalNotifications,
    deliveries,
    attempts,
    destinations,
    digests,
    audit,
    anonymization,
    adapter,
    fanOutScheduler,
    renderScheduler,
    sendScheduler,
    subjectAuthorizer,
    adminPermissionCalls,
    runtimeStopCount: () => runtimeStops,
  };
};
