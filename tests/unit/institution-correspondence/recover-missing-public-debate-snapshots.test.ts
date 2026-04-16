import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createDatabaseError as createCorrespondenceDatabaseError,
  PUBLIC_DEBATE_REQUEST_TYPE,
  recoverMissingPublicDebateSnapshots,
  type PublicDebateEntityUpdateNotification,
} from '@/modules/institution-correspondence/index.js';
import { enqueuePublicDebateEntityUpdateNotifications } from '@/modules/notification-delivery/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  sha256Hasher,
} from '@/modules/notifications/index.js';

import {
  createAdminResponseEvent,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';
import {
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';
import { createPublicDebateNotificationHarness } from '../../fixtures/public-debate-notification-harness.js';

describe('recoverMissingPublicDebateSnapshots', () => {
  it('publishes a missing snapshot after an earlier publish failure', async () => {
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-05T08:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Oras Test',
          }),
        }),
      ],
    });
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [notification],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const failingResult = await recoverMissingPublicDebateSnapshots({
      repo,
      notificationsRepo,
      deliveryRepo,
      updatePublisher: {
        async publish() {
          return err(createCorrespondenceDatabaseError('publisher failed'));
        },
      },
    });

    expect(failingResult.isOk()).toBe(true);
    if (failingResult.isOk()) {
      expect(failingResult.value.publishedCount).toBe(0);
      expect(failingResult.value.errors).toEqual({
        '12345678': 'publisher failed',
      });
    }

    const successfulResult = await recoverMissingPublicDebateSnapshots({
      repo,
      notificationsRepo,
      deliveryRepo,
      updatePublisher: {
        async publish(input) {
          const sharedEnqueueInput = {
            runId: `snapshot-${input.thread.id}`,
            entityCui: input.thread.entityCui,
            entityName: 'Oras Test',
            threadId: input.thread.id,
            threadKey: input.thread.threadKey,
            phase: input.thread.phase,
            institutionEmail: input.thread.record.institutionEmail,
            subject: input.thread.record.subject,
            occurredAt: input.occurredAt.toISOString(),
            ...(input.reply !== undefined ? { replyEntryId: input.reply.id } : {}),
            ...(input.basedOnEntryId !== undefined ? { basedOnEntryId: input.basedOnEntryId } : {}),
            ...(input.resolutionCode !== undefined ? { resolutionCode: input.resolutionCode } : {}),
            ...(input.reviewNotes !== undefined ? { reviewNotes: input.reviewNotes } : {}),
          };
          const enqueueInput =
            input.eventType === 'thread_started'
              ? {
                  ...sharedEnqueueInput,
                  eventType: input.eventType,
                  requesterUserId: input.requesterUserId,
                }
              : {
                  ...sharedEnqueueInput,
                  eventType: input.eventType,
                };

          const enqueueResult = await enqueuePublicDebateEntityUpdateNotifications(
            {
              notificationsRepo,
              deliveryRepo,
              composeJobScheduler: {
                enqueue: async () => ok(undefined),
              },
            },
            enqueueInput
          );

          if (enqueueResult.isErr()) {
            return err(
              createCorrespondenceDatabaseError(
                'Failed to enqueue public debate entity update notifications',
                enqueueResult.error
              )
            );
          }

          return ok({
            status: 'queued' as const,
            notificationIds: enqueueResult.value.notificationIds,
            createdOutboxIds: enqueueResult.value.createdOutboxIds,
            reusedOutboxIds: enqueueResult.value.reusedOutboxIds,
            queuedOutboxIds: enqueueResult.value.queuedOutboxIds,
            enqueueFailedOutboxIds: enqueueResult.value.enqueueFailedOutboxIds,
          });
        },
      },
    });

    expect(successfulResult.isOk()).toBe(true);
    if (successfulResult.isOk()) {
      expect(successfulResult.value.publishedCount).toBe(1);
      expect(successfulResult.value.publishedEntityCuis).toEqual(['12345678']);
      expect(successfulResult.value.errors).toEqual({});
    }
  });

  it('does not republish when the expected snapshot outbox already exists', async () => {
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-05T08:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Oras Test',
          }),
        }),
      ],
    });
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [notification],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const seededOutbox = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async () => ok(undefined),
        },
      },
      {
        runId: 'seed-thread-started',
        eventType: 'thread_started',
        entityCui: '12345678',
        entityName: 'Oras Test',
        threadId: 'thread-1',
        threadKey: 'thread-key-thread-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Oras Test',
        occurredAt: '2026-04-05T08:00:00.000Z',
      }
    );
    expect(seededOutbox.isOk()).toBe(true);
    if (seededOutbox.isOk()) {
      const outboxId = seededOutbox.value.createdOutboxIds[0];
      expect(outboxId).toBeDefined();
      if (outboxId !== undefined) {
        const renderResult = await deliveryRepo.updateRenderedContent(outboxId, {
          renderedSubject: 'Rendered subject',
          renderedHtml: '<p>Rendered body</p>',
          renderedText: 'Rendered body',
          contentHash: 'content-hash',
          templateName: 'public_debate_entity_update',
          templateVersion: '1',
        });
        expect(renderResult.isOk()).toBe(true);
      }
    }

    const publish = vi.fn(async () =>
      ok({
        status: 'queued' as const,
        notificationIds: ['notification-1'],
        createdOutboxIds: ['outbox-unexpected'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['outbox-unexpected'],
        enqueueFailedOutboxIds: [],
      })
    );

    const result = await recoverMissingPublicDebateSnapshots({
      repo,
      notificationsRepo,
      deliveryRepo,
      updatePublisher: {
        publish,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.publishedCount).toBe(0);
      expect(result.value.alreadyMaterializedCount).toBe(1);
      expect(result.value.alreadyMaterializedEntityCuis).toEqual(['12345678']);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('republishes when the snapshot outbox exists but compose scheduling previously failed', async () => {
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-05T08:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Oras Test',
          }),
        }),
      ],
    });
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [notification],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const seededOutbox = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async () =>
            err({
              type: 'QueueError',
              message: 'compose queue unavailable',
              retryable: true,
            }),
        },
      },
      {
        runId: 'seed-thread-started',
        eventType: 'thread_started',
        entityCui: '12345678',
        entityName: 'Oras Test',
        threadId: 'thread-1',
        threadKey: 'thread-key-thread-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Oras Test',
        occurredAt: '2026-04-05T08:00:00.000Z',
      }
    );
    expect(seededOutbox.isOk()).toBe(true);
    if (seededOutbox.isOk()) {
      expect(seededOutbox.value.createdOutboxIds).toHaveLength(1);
      expect(seededOutbox.value.enqueueFailedOutboxIds).toHaveLength(1);
    }

    const publish = vi.fn(async (input: PublicDebateEntityUpdateNotification) => {
      const sharedEnqueueInput = {
        runId: `snapshot-retry-${input.thread.id}`,
        entityCui: input.thread.entityCui,
        entityName: 'Oras Test',
        threadId: input.thread.id,
        threadKey: input.thread.threadKey,
        phase: input.thread.phase,
        institutionEmail: input.thread.record.institutionEmail,
        subject: input.thread.record.subject,
        occurredAt: input.occurredAt.toISOString(),
        ...(input.reply !== undefined ? { replyEntryId: input.reply.id } : {}),
        ...(input.basedOnEntryId !== undefined ? { basedOnEntryId: input.basedOnEntryId } : {}),
        ...(input.resolutionCode !== undefined ? { resolutionCode: input.resolutionCode } : {}),
        ...(input.reviewNotes !== undefined ? { reviewNotes: input.reviewNotes } : {}),
      };
      const enqueueInput =
        input.eventType === 'thread_started'
          ? {
              ...sharedEnqueueInput,
              eventType: input.eventType,
              requesterUserId: input.requesterUserId,
            }
          : {
              ...sharedEnqueueInput,
              eventType: input.eventType,
            };

      const enqueueResult = await enqueuePublicDebateEntityUpdateNotifications(
        {
          notificationsRepo,
          deliveryRepo,
          composeJobScheduler: {
            enqueue: async () => ok(undefined),
          },
        },
        enqueueInput
      );

      if (enqueueResult.isErr()) {
        return err(
          createCorrespondenceDatabaseError(
            'Failed to enqueue public debate entity update notifications',
            enqueueResult.error
          )
        );
      }

      return ok({
        status: 'queued' as const,
        notificationIds: enqueueResult.value.notificationIds,
        createdOutboxIds: enqueueResult.value.createdOutboxIds,
        reusedOutboxIds: enqueueResult.value.reusedOutboxIds,
        queuedOutboxIds: enqueueResult.value.queuedOutboxIds,
        enqueueFailedOutboxIds: enqueueResult.value.enqueueFailedOutboxIds,
      });
    });

    const result = await recoverMissingPublicDebateSnapshots({
      repo,
      notificationsRepo,
      deliveryRepo,
      updatePublisher: {
        publish,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.publishedCount).toBe(1);
      expect(result.value.alreadyMaterializedCount).toBe(0);
      expect(result.value.publishedEntityCuis).toEqual(['12345678']);
    }
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('skips entities whose latest thread state has no recoverable snapshot', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-1',
          userId: 'user-1',
          entityCui: '12345678',
          notificationType: 'funky:notification:entity_updates',
        }),
        createTestNotification({
          id: 'notification-2',
          userId: 'user-2',
          entityCui: '87654321',
          notificationType: 'funky:notification:entity_updates',
        }),
      ],
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-sending',
          entityCui: '12345678',
          phase: 'sending',
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
          }),
        }),
        createThreadRecord({
          id: 'thread-closed',
          entityCui: '87654321',
          phase: 'closed_no_response',
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
          }),
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const publish = vi.fn(async () =>
      ok({
        status: 'queued' as const,
        notificationIds: [],
        createdOutboxIds: [],
        reusedOutboxIds: [],
        queuedOutboxIds: [],
        enqueueFailedOutboxIds: [],
      })
    );

    const result = await recoverMissingPublicDebateSnapshots({
      repo,
      notificationsRepo,
      deliveryRepo,
      updatePublisher: {
        publish,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.entityCount).toBe(2);
      expect(result.value.derivedCount).toBe(0);
      expect(result.value.skippedCount).toBe(2);
      expect(result.value.skippedEntityCuis).toEqual(['12345678', '87654321']);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('skips backfill for terminal admin responses that only exist in adminWorkflow', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-1',
          userId: 'user-1',
          entityCui: '12345678',
          notificationType: 'funky:notification:entity_updates',
        }),
      ],
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-admin-resolved',
          entityCui: '12345678',
          phase: 'resolved_positive',
          lastEmailAt: new Date('2026-04-05T08:00:00.000Z'),
          closedAt: new Date('2026-04-05T09:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Oras Test',
            adminWorkflow: {
              currentResponseStatus: 'request_confirmed',
              responseEvents: [
                createAdminResponseEvent({
                  id: 'admin-response-1',
                  responseStatus: 'request_confirmed',
                  responseDate: '2026-04-05T09:00:00.000Z',
                  createdAt: '2026-04-05T09:01:00.000Z',
                }),
              ],
            },
          }),
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const publish = vi.fn(async () =>
      ok({
        status: 'queued' as const,
        notificationIds: ['unexpected'],
        createdOutboxIds: ['unexpected'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['unexpected'],
        enqueueFailedOutboxIds: [],
      })
    );

    const result = await recoverMissingPublicDebateSnapshots({
      repo,
      notificationsRepo,
      deliveryRepo,
      updatePublisher: {
        publish,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.derivedCount).toBe(0);
      expect(result.value.skippedCount).toBe(1);
      expect(result.value.skippedEntityCuis).toEqual(['12345678']);
      expect(result.value.publishedCount).toBe(0);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('never emits admin failure alerts during recovery-only failed-thread backfill', async () => {
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-failed',
          entityCui: '12345678',
          phase: 'failed',
          record: createThreadAggregateRecord({
            campaign: 'funky',
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Oras Test',
          }),
        }),
      ],
      entityNames: {
        '12345678': 'Oras Test',
      },
      auditCcRecipients: ['Review@Test.Example.com'],
    });

    const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo: harness.notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );
    expect(subscriptionResult.isOk()).toBe(true);

    const entityNotificationResult = await harness.notificationsRepo.findByUserTypeAndEntity(
      'user-1',
      'funky:notification:entity_updates',
      '12345678'
    );
    expect(entityNotificationResult.isOk()).toBe(true);
    if (entityNotificationResult.isOk()) {
      expect(entityNotificationResult.value).not.toBeNull();
    }

    const result = await recoverMissingPublicDebateSnapshots({
      repo: harness.correspondenceRepo,
      notificationsRepo: harness.extendedNotificationsRepo,
      deliveryRepo: harness.deliveryRepo,
      updatePublisher: harness.updatePublisher,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.publishedCount).toBe(1);
      expect(result.value.publishedEntityCuis).toEqual(['12345678']);
    }

    const adminFailureOutbox = await harness.deliveryRepo.findByDeliveryKey(
      'admin:review@test.example.com:admin_failure:thread-failed'
    );
    expect(adminFailureOutbox.isOk()).toBe(true);
    if (adminFailureOutbox.isOk()) {
      expect(adminFailureOutbox.value).toBeNull();
    }
  });
});
