import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { PUBLIC_DEBATE_REQUEST_TYPE } from '@/modules/institution-correspondence/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  generateDeliveryKey,
  sha256Hasher,
} from '@/modules/notifications/index.js';
import { makeEntityTermsAcceptedUserEventHandler } from '@/modules/user-events/index.js';

import {
  createTestInteractiveRecord,
  createPublicDebateNotificationHarness,
  makeFakeLearningProgressRepo,
} from '../fixtures/index.js';
import {
  createThreadAggregateRecord,
  createThreadRecord,
} from '../unit/institution-correspondence/fake-repo.js';

const createAcceptedEntityTermsRecord = (input?: { entityCui?: string; updatedAt?: string }) => {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-03-31T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `funky:progress:terms_accepted::entity:${entityCui}`,
    interactionId: `funky:progress:terms_accepted::entity:${entityCui}`,
    lessonId: 'funky:progress:state',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'global' },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: {
          entityCui,
          acceptedTermsAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: null,
  });
};

describe('public debate notification boundaries', () => {
  it('keeps entity terms acceptance out of the current-thread snapshot path', async () => {
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-03T16:43:04.930Z'),
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Oras Test',
            institutionEmail: 'contact@primarie.ro',
          }),
        }),
      ],
      entityNames: {
        '12345678': 'Oras Test',
      },
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
    if (subscriptionResult.isOk()) {
      const record = createAcceptedEntityTermsRecord();
      const learningProgressRepo = makeFakeLearningProgressRepo({
        initialRecords: new Map([
          [
            'user-1',
            [
              {
                userId: 'user-1',
                recordKey: record.key,
                record,
                auditEvents: [],
                updatedSeq: '1',
                createdAt: record.updatedAt,
                updatedAt: record.updatedAt,
              },
            ],
          ],
        ]),
      });
      const handler = makeEntityTermsAcceptedUserEventHandler({
        learningProgressRepo,
        notificationsRepo: harness.notificationsRepo,
        extendedNotificationsRepo: harness.extendedNotificationsRepo,
        deliveryRepo: harness.deliveryRepo,
        composeJobScheduler: {
          enqueue: async () => ok(undefined),
        },
        entityRepo: harness.entityRepo,
        logger: pinoLogger({ level: 'silent' }),
      });

      await handler.handle({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'interactive.updated',
        occurredAt: record.updatedAt,
        recordKey: record.key,
      });

      const entityUpdateKey = generateDeliveryKey(
        'user-1',
        subscriptionResult.value.entitySubscription.id,
        'funky:delivery:thread_started_thread-1'
      );
      const entityUpdateOutbox = await harness.deliveryRepo.findByDeliveryKey(entityUpdateKey);
      const welcomeOutbox = await harness.deliveryRepo.findByDeliveryKey(
        'funky:outbox:welcome:user-1'
      );

      expect(entityUpdateOutbox.isOk()).toBe(true);
      expect(welcomeOutbox.isOk()).toBe(true);
      if (entityUpdateOutbox.isOk() && welcomeOutbox.isOk()) {
        expect(entityUpdateOutbox.value).toBeNull();
        expect(welcomeOutbox.value?.notificationType).toBe('funky:outbox:welcome');
      }
      expect(harness.snapshotResults).toEqual([]);
    }
  });
});
