import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  buildAnafForexebugDigestScopeKey,
  materializeAnafForexebugDigests,
} from '@/modules/notification-delivery/index.js';

import {
  createTestNotification,
  createTestDeliveryRecord,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';

import type { DeliveryRepository } from '@/modules/notification-delivery/core/ports.js';
import type { ComposeJobPayload } from '@/modules/notification-delivery/core/types.js';

describe('materializeAnafForexebugDigests', () => {
  it('creates one ANAF / Forexebug digest outbox row per user and enqueues compose once', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
          hash: 'hash-newsletter-1',
        }),
        createTestNotification({
          id: 'alert-1',
          userId: 'user-1',
          notificationType: 'alert_series_analytics',
          config: { conditions: [], filter: {} },
          hash: 'hash-alert-1',
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-1',
        periodKey: '2026-03',
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.digestCount).toBe(1);
    expect(value.eligibleNotificationCount).toBe(2);
    expect(value.composeJobsEnqueued).toBe(1);

    const outbox = await deliveryRepo.findByDeliveryKey('digest:anaf_forexebug:user-1:2026-03');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.notificationType).toBe('anaf_forexebug_digest');
      expect(outbox.value?.referenceId).toBeNull();
      expect(outbox.value?.scopeKey).toBe(buildAnafForexebugDigestScopeKey('2026-03'));
      expect(outbox.value?.metadata['sourceNotificationIds']).toEqual(['newsletter-1', 'alert-1']);
      expect(outbox.value?.metadata['sourceNotificationVersions']).toEqual({
        'newsletter-1': {
          notificationType: 'newsletter_entity_monthly',
          hash: 'hash-newsletter-1',
        },
        'alert-1': {
          notificationType: 'alert_series_analytics',
          hash: 'hash-alert-1',
        },
      });
      expect(outbox.value?.metadata['itemCount']).toBe(2);
      expect(outbox.value?.metadata['digestType']).toBe('anaf_forexebug_digest');
      expect(outbox.value?.metadata['bundleItems']).toBeUndefined();
    }

    expect(jobs).toEqual([
      {
        runId: 'run-1',
        kind: 'outbox',
        outboxId: expect.any(String),
      },
    ]);
  });

  it('supports dry runs without creating outbox rows or enqueueing compose', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
      digestedNotificationIdsByPeriod: {
        '2026-03': ['newsletter-1'],
      },
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-2',
        periodKey: '2026-03',
        dryRun: true,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().composeJobsEnqueued).toBe(0);
    expect(jobs).toEqual([]);

    const outbox = await deliveryRepo.findByDeliveryKey('digest:anaf_forexebug:user-1:2026-03');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value).toBeNull();
    }
  });

  it('applies the global limit fairly across source types', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'newsletter-2',
          userId: 'user-1',
          entityCui: '456',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'alert-analytics-1',
          userId: 'user-1',
          notificationType: 'alert_series_analytics',
          config: { conditions: [], filter: {} },
        }),
        createTestNotification({
          id: 'alert-analytics-2',
          userId: 'user-1',
          notificationType: 'alert_series_analytics',
          config: { conditions: [], filter: {} },
        }),
        createTestNotification({
          id: 'alert-static-1',
          userId: 'user-1',
          notificationType: 'alert_series_static',
          config: { conditions: [], filter: {} },
        }),
        createTestNotification({
          id: 'alert-static-2',
          userId: 'user-1',
          notificationType: 'alert_series_static',
          config: { conditions: [], filter: {} },
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-fair-limit',
        periodKey: '2026-03',
        limit: 4,
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.eligibleNotificationCount).toBe(4);
    expect(value.digestCount).toBe(1);
    expect(jobs).toHaveLength(1);

    const outbox = await deliveryRepo.findByDeliveryKey('digest:anaf_forexebug:user-1:2026-03');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.scopeKey).toBe(buildAnafForexebugDigestScopeKey('2026-03'));
      expect(outbox.value?.metadata['sourceNotificationIds']).toEqual([
        'newsletter-1',
        'alert-analytics-1',
        'alert-static-1',
        'newsletter-2',
      ]);
      expect(outbox.value?.metadata['itemCount']).toBe(4);
    }
  });

  it('filters eligible notifications to the requested user ids', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-user-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'newsletter-user-2',
          userId: 'user-2',
          entityCui: '456',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-user-filter',
        periodKey: '2026-03',
        userIds: ['user-2'],
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.eligibleNotificationCount).toBe(1);
    expect(value.digestCount).toBe(1);
    expect(jobs).toHaveLength(1);

    const includedOutbox = await deliveryRepo.findByDeliveryKey(
      'digest:anaf_forexebug:user-2:2026-03'
    );
    expect(includedOutbox.isOk()).toBe(true);
    if (includedOutbox.isOk()) {
      expect(includedOutbox.value?.scopeKey).toBe(buildAnafForexebugDigestScopeKey('2026-03'));
      expect(includedOutbox.value?.metadata['sourceNotificationIds']).toEqual([
        'newsletter-user-2',
      ]);
    }

    const excludedOutbox = await deliveryRepo.findByDeliveryKey(
      'digest:anaf_forexebug:user-1:2026-03'
    );
    expect(excludedOutbox.isOk()).toBe(true);
    if (excludedOutbox.isOk()) {
      expect(excludedOutbox.value).toBeNull();
    }
  });

  it('applies limit after filtering to the requested user ids', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-user-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'newsletter-user-2',
          userId: 'user-2',
          entityCui: '456',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-user-filter-limit',
        periodKey: '2026-03',
        userIds: ['user-2'],
        limit: 1,
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.eligibleNotificationCount).toBe(1);
    expect(value.digestCount).toBe(1);
    expect(value.composeJobsEnqueued).toBe(1);
    expect(jobs).toHaveLength(1);

    const includedOutbox = await deliveryRepo.findByDeliveryKey(
      'digest:anaf_forexebug:user-2:2026-03'
    );
    expect(includedOutbox.isOk()).toBe(true);
    if (includedOutbox.isOk()) {
      expect(includedOutbox.value?.scopeKey).toBe(buildAnafForexebugDigestScopeKey('2026-03'));
      expect(includedOutbox.value?.metadata['sourceNotificationIds']).toEqual([
        'newsletter-user-2',
      ]);
    }
  });

  it('does not create digest outboxes for globally unsubscribed users', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-user-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'newsletter-user-2',
          userId: 'user-2',
          entityCui: '456',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'global-user-1',
          userId: 'user-1',
          entityCui: null,
          notificationType: 'global_unsubscribe',
          isActive: false,
          config: { channels: { email: false } },
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-global-unsub-filter',
        periodKey: '2026-03',
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.eligibleNotificationCount).toBe(1);
    expect(value.digestCount).toBe(1);
    expect(value.composeJobsEnqueued).toBe(1);

    const excludedOutbox = await deliveryRepo.findByDeliveryKey(
      'digest:anaf_forexebug:user-1:2026-03'
    );
    expect(excludedOutbox.isOk()).toBe(true);
    if (excludedOutbox.isOk()) {
      expect(excludedOutbox.value).toBeNull();
    }

    const includedOutbox = await deliveryRepo.findByDeliveryKey(
      'digest:anaf_forexebug:user-2:2026-03'
    );
    expect(includedOutbox.isOk()).toBe(true);
    if (includedOutbox.isOk()) {
      expect(includedOutbox.value?.scopeKey).toBe(buildAnafForexebugDigestScopeKey('2026-03'));
      expect(includedOutbox.value?.metadata['sourceNotificationIds']).toEqual([
        'newsletter-user-2',
      ]);
    }
  });

  it('does not include source notifications already materialized directly for the period', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-direct-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'newsletter-digest-1',
          userId: 'user-1',
          entityCui: '456',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
      deliveredNotificationIdsByPeriod: {
        '2026-03': ['newsletter-direct-1'],
      },
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-direct-first',
        periodKey: '2026-03',
      }
    );

    expect(result.isOk()).toBe(true);
    const outbox = await deliveryRepo.findByDeliveryKey('digest:anaf_forexebug:user-1:2026-03');
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.metadata['sourceNotificationIds']).toEqual(['newsletter-digest-1']);
    }
    expect(jobs).toHaveLength(1);
  });

  it('re-enqueues compose when a duplicate digest row already exists in pending state', async () => {
    const baseRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'existing-digest-outbox',
          userId: 'user-1',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: buildAnafForexebugDigestScopeKey('2026-03'),
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          status: 'pending',
          renderedSubject: null,
          renderedHtml: null,
          renderedText: null,
          metadata: {
            digestType: 'anaf_forexebug_digest',
            sourceNotificationIds: ['newsletter-1'],
            itemCount: 1,
          },
        }),
      ],
    });
    const deliveryRepo = {
      ...baseRepo,
      create: async () =>
        err({
          type: 'DuplicateDelivery',
          message: 'Duplicate delivery key: digest:anaf_forexebug:user-1:2026-03',
          retryable: false,
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
        }),
    } satisfies DeliveryRepository;
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'newsletter-1',
          userId: 'user-1',
          entityCui: '123',
          notificationType: 'newsletter_entity_monthly',
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const result = await materializeAnafForexebugDigests(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async (job) => {
            jobs.push(job);
            return ok(undefined);
          },
        },
      },
      {
        runId: 'run-duplicate-requeue',
        periodKey: '2026-03',
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.composeJobsEnqueued).toBe(1);
    expect(value.outboxIds).toEqual(['existing-digest-outbox']);
    expect(jobs).toEqual([
      {
        runId: 'run-duplicate-requeue',
        kind: 'outbox',
        outboxId: 'existing-digest-outbox',
      },
    ]);
  });
});
