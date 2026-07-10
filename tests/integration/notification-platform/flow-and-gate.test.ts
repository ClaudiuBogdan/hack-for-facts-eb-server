import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '@/app/build-app.js';
import { createTestAuthProvider } from '@/modules/auth/index.js';
import { recordNotificationEvent } from '@/modules/notification-platform/index.js';

import {
  authHeaders,
  makeNotificationPlatformIntegrationHarness,
  type NotificationPlatformIntegrationHarness,
} from './harness.js';
import { makeTestConfig } from '../../fixtures/builders.js';
import {
  makeFakeBudgetDb,
  makeFakeDatasetRepo,
  makeFakeInsDb,
  makeFakeKyselyDb,
} from '../../fixtures/fakes.js';

describe('notification platform app wiring and end-to-end flow', () => {
  let harness: NotificationPlatformIntegrationHarness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  it('keeps routes and platform runtime absent when the feature is disabled', async () => {
    const auth = createTestAuthProvider();
    const platformRuntimeFactory = vi.fn();
    const notificationDeliveryRuntimeFactory = vi.fn(async () => ({
      collectQueue: {} as never,
      composeJobScheduler: {} as never,
      stop: async () => undefined,
    }));
    const userEventRuntimeFactory = vi.fn(async () => ({
      publisher: {
        publish: async () => undefined,
        publishMany: async () => undefined,
      },
      stop: async () => undefined,
    }));
    const app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: makeFakeBudgetDb(),
        insDb: makeFakeInsDb(),
        userDb: makeFakeKyselyDb(),
        datasetRepo: makeFakeDatasetRepo(),
        authProvider: auth.provider,
        notificationDeliveryRuntimeFactory,
        userEventRuntimeFactory,
        notificationPlatformRuntimeFactory: platformRuntimeFactory,
        config: makeTestConfig({
          jobs: {
            redisUrl: 'redis://notification-platform-gate.test:6379',
            redisPassword: undefined,
            concurrency: 5,
            prefix: 'test:notification-platform-gate',
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
            enabled: false,
            ingestionScanSeconds: 60,
            recoveryScanMinutes: 2,
            digestSweepMinutes: 5,
            recoveryThresholdMinutes: 10,
            retentionBatchLimit: 500,
            maxSendRps: 2,
            destinationFingerprintSecret: 'configured-but-gated-off',
          },
        }),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/inbox',
      headers: { authorization: `Bearer ${auth.tokens.user1}` },
    });
    expect(response.statusCode).toBe(404);
    expect(platformRuntimeFactory).not.toHaveBeenCalled();
    expect(app.printRoutes()).not.toContain('notifications/inbox');
    await app.close();
  });

  it('does not initialize the enabled platform when BullMQ config is missing', async () => {
    const auth = createTestAuthProvider();
    const platformRuntimeFactory = vi.fn();
    const app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: makeFakeBudgetDb(),
        insDb: makeFakeInsDb(),
        userDb: makeFakeKyselyDb(),
        datasetRepo: makeFakeDatasetRepo(),
        authProvider: auth.provider,
        notificationPlatformRuntimeFactory: platformRuntimeFactory,
        config: makeTestConfig({
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
            maxSendRps: 2,
            destinationFingerprintSecret: 'fingerprint-secret-without-bullmq',
          },
        }),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/inbox',
      headers: { authorization: `Bearer ${auth.tokens.user1}` },
    });
    expect(response.statusCode).toBe(404);
    expect(platformRuntimeFactory).not.toHaveBeenCalled();
    await app.close();
  });

  it('stops the platform runtime when route composition fails during boot', async () => {
    const onRuntimeStop = vi.fn();

    await expect(
      makeNotificationPlatformIntegrationHarness({
        onRuntimeStop,
        adminRoutesFactory: () => {
          throw new Error('injected notification admin route registration failure');
        },
      })
    ).rejects.toThrow('injected notification admin route registration failure');
    expect(onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it('fails fast with an actionable fingerprint-secret error when enabled', async () => {
    const auth = createTestAuthProvider();
    await expect(
      createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          insDb: makeFakeInsDb(),
          datasetRepo: makeFakeDatasetRepo(),
          authProvider: auth.provider,
          config: makeTestConfig({
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
              maxSendRps: 2,
              destinationFingerprintSecret: undefined,
            },
          }),
        },
      })
    ).rejects.toThrow('NP_DESTINATION_FINGERPRINT_SECRET');
  });

  it('flows subscription to event fan-out to inbox and read state through HTTP', async () => {
    harness = await makeNotificationPlatformIntegrationHarness();
    const subscriptionResponse = await harness.app.inject({
      method: 'POST',
      url: '/api/notifications/subscriptions',
      headers: authHeaders(harness),
      payload: {
        kindId: harness.kind.kindId,
        subjectType: 'test-subject',
        subjectId: 'subject-1',
        config: {},
      },
    });
    expect(subscriptionResponse.statusCode).toBe(201);

    const recorded = await recordNotificationEvent(
      {
        events: harness.events,
        registry: harness.registry,
        audit: harness.audit,
        fanOutScheduler: harness.fanOutScheduler,
        clock: harness.clock,
        ids: harness.ids,
        logger: harness.logger,
      },
      {
        source: 'integration-flow',
        eventType: harness.kind.eventType,
        eventSchemaVersion: harness.kind.eventSchemaVersion,
        occurrenceKey: 'integration-flow-1',
        occurredAt: harness.clock.now(),
        facts: { subjectId: 'subject-1', title: 'HTTP inbox flow' },
      }
    );
    expect(recorded.isOk()).toBe(true);

    const outcomes = await harness.runtime.runAll();
    expect(outcomes.every((outcome) => outcome.outcome === 'completed')).toBe(true);

    const inbox = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox',
      headers: authHeaders(harness),
    });
    expect(inbox.statusCode).toBe(200);
    const inboxItems = inbox.json<{ data: { items: { id: string; inboxTitle: string }[] } }>().data
      .items;
    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]?.inboxTitle).toBe('HTTP inbox flow');

    const unreadBefore = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox/unread-count',
      headers: authHeaders(harness),
    });
    expect(unreadBefore.json<{ data: { count: number } }>().data.count).toBe(1);

    const markRead = await harness.app.inject({
      method: 'POST',
      url: `/api/notifications/inbox/${String(inboxItems[0]?.id)}/read`,
      headers: authHeaders(harness),
    });
    expect(markRead.statusCode).toBe(200);

    const unreadAfter = await harness.app.inject({
      method: 'GET',
      url: '/api/notifications/inbox/unread-count',
      headers: authHeaders(harness),
    });
    expect(unreadAfter.json<{ data: { count: number } }>().data.count).toBe(0);
  });
});
