import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeEntityTermsAcceptedUserEventHandler } from '@/modules/user-events/index.js';

import {
  createTestDeliveryRecord,
  createTestInteractiveRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeLearningProgressRepo,
  makeFakeNotificationsRepo,
} from '../../fixtures/fakes.js';

import type { EntityRepository } from '@/modules/entity/index.js';
import type {
  LearningProgressRecordRow,
  LearningProgressRepository,
} from '@/modules/learning-progress/index.js';
import type {
  ComposeJobPayload,
  ComposeJobScheduler,
} from '@/modules/notification-delivery/index.js';

function makeLearningRow(
  userId: string,
  record: LearningProgressRecordRow['record']
): LearningProgressRecordRow {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq: '1',
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  };
}

function createAcceptedEntityTermsRecord(input?: { entityCui?: string; updatedAt?: string }) {
  const entityCui = input?.entityCui ?? '12345678';
  const updatedAt = input?.updatedAt ?? '2026-03-31T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: `system:campaign:buget:accepted-terms:entity:${entityCui}`,
    interactionId: `system:campaign:buget:accepted-terms:entity:${entityCui}`,
    lessonId: 'system:campaign:buget:state',
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
}

const makeComposeJobScheduler = (jobs: ComposeJobPayload[]): ComposeJobScheduler => ({
  async enqueue(job) {
    jobs.push(job);
    return ok(undefined);
  },
});

const makeEntityRepo = (entities: Record<string, string>): EntityRepository => ({
  async getById(cui) {
    const name = entities[cui];
    if (name === undefined) {
      return ok(null);
    }

    return ok({
      cui,
      name,
      entity_type: null,
      default_report_type: 'Executie bugetara detaliata',
      uat_id: null,
      is_uat: false,
      address: null,
      last_updated: new Date(),
      main_creditor_1_cui: null,
      main_creditor_2_cui: null,
    });
  },
  async getByIds(cuis) {
    return ok(
      new Map(
        cuis
          .filter((cui) => entities[cui] !== undefined)
          .map((cui) => [
            cui,
            {
              cui,
              name: entities[cui] ?? cui,
              entity_type: null,
              default_report_type: 'Executie bugetara detaliata',
              uat_id: null,
              is_uat: false,
              address: null,
              last_updated: new Date(),
              main_creditor_1_cui: null,
              main_creditor_2_cui: null,
            },
          ])
      )
    );
  },
  async getAll() {
    throw new Error('not implemented');
  },
  async getChildren() {
    throw new Error('not implemented');
  },
  async getParents() {
    throw new Error('not implemented');
  },
  async getCountyEntity() {
    throw new Error('not implemented');
  },
});

describe('makeEntityTermsAcceptedUserEventHandler', () => {
  it('queues only the campaign welcome email for the first accepted entity', async () => {
    const record = createAcceptedEntityTermsRecord();
    const learningProgressRepo: LearningProgressRepository = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-global-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_global',
          entityCui: null,
        }),
        createTestNotification({
          id: 'notification-entity-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const jobs: ComposeJobPayload[] = [];

    const handler = makeEntityTermsAcceptedUserEventHandler({
      learningProgressRepo,
      notificationsRepo,
      deliveryRepo,
      composeJobScheduler: makeComposeJobScheduler(jobs),
      entityRepo: makeEntityRepo({ '12345678': 'Primaria Test' }),
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

    const welcome = await deliveryRepo.findByDeliveryKey('campaign_public_debate_welcome:user-1');
    const entitySubscription = await deliveryRepo.findByDeliveryKey(
      'campaign_public_debate_entity_subscription:user-1:12345678'
    );

    expect(welcome.isOk()).toBe(true);
    expect(entitySubscription.isOk()).toBe(true);
    if (welcome.isOk() && entitySubscription.isOk()) {
      expect(welcome.value?.notificationType).toBe('campaign_public_debate_welcome');
      expect(welcome.value?.metadata['entityName']).toBe('Primaria Test');
      expect(entitySubscription.value).toBeNull();
    }
    expect(jobs).toHaveLength(1);
  });

  it('queues an entity subscription confirmation for a later accepted entity', async () => {
    const record = createAcceptedEntityTermsRecord({ entityCui: '87654321' });
    const learningProgressRepo: LearningProgressRepository = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-global-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_global',
          entityCui: null,
        }),
        createTestNotification({
          id: 'notification-entity-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_entity_updates',
          entityCui: '12345678',
        }),
        createTestNotification({
          id: 'notification-entity-2',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_entity_updates',
          entityCui: '87654321',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-welcome-1',
          notificationType: 'campaign_public_debate_welcome',
          referenceId: 'notification-global-1',
          scopeKey: 'public_debate:welcome',
          deliveryKey: 'campaign_public_debate_welcome:user-1',
          status: 'delivered',
          metadata: {
            campaignKey: 'public_debate',
            entityCui: '12345678',
            entityName: 'Prima Entitate',
            acceptedTermsAt: '2026-03-31T10:00:00.000Z',
          },
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const handler = makeEntityTermsAcceptedUserEventHandler({
      learningProgressRepo,
      notificationsRepo,
      deliveryRepo,
      composeJobScheduler: makeComposeJobScheduler(jobs),
      entityRepo: makeEntityRepo({
        '12345678': 'Prima Entitate',
        '87654321': 'A Doua Entitate',
      }),
      logger: pinoLogger({ level: 'silent' }),
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-2',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    const entitySubscription = await deliveryRepo.findByDeliveryKey(
      'campaign_public_debate_entity_subscription:user-1:87654321'
    );

    expect(entitySubscription.isOk()).toBe(true);
    if (entitySubscription.isOk()) {
      expect(entitySubscription.value?.notificationType).toBe(
        'campaign_public_debate_entity_subscription'
      );
      expect(entitySubscription.value?.metadata['entityName']).toBe('A Doua Entitate');
      expect(entitySubscription.value?.metadata['selectedEntities']).toEqual([
        'A Doua Entitate',
        'Prima Entitate',
      ]);
    }
    expect(jobs).toHaveLength(1);
  });

  it('does not create an entity confirmation when the first entity acceptance is replayed', async () => {
    const record = createAcceptedEntityTermsRecord();
    const learningProgressRepo: LearningProgressRepository = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-global-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_global',
          entityCui: null,
        }),
        createTestNotification({
          id: 'notification-entity-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-welcome-1',
          notificationType: 'campaign_public_debate_welcome',
          referenceId: 'notification-global-1',
          scopeKey: 'public_debate:welcome',
          deliveryKey: 'campaign_public_debate_welcome:user-1',
          status: 'delivered',
          metadata: {
            campaignKey: 'public_debate',
            entityCui: '12345678',
            entityName: 'Primaria Test',
            acceptedTermsAt: '2026-03-31T10:00:00.000Z',
          },
        }),
      ],
    });
    const jobs: ComposeJobPayload[] = [];

    const handler = makeEntityTermsAcceptedUserEventHandler({
      learningProgressRepo,
      notificationsRepo,
      deliveryRepo,
      composeJobScheduler: makeComposeJobScheduler(jobs),
      entityRepo: makeEntityRepo({ '12345678': 'Primaria Test' }),
      logger: pinoLogger({ level: 'silent' }),
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-3',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    const entitySubscription = await deliveryRepo.findByDeliveryKey(
      'campaign_public_debate_entity_subscription:user-1:12345678'
    );

    expect(entitySubscription.isOk()).toBe(true);
    if (entitySubscription.isOk()) {
      expect(entitySubscription.value).toBeNull();
    }
    expect(jobs).toHaveLength(0);
  });

  it('skips enqueue when the campaign notification scope is inactive', async () => {
    const record = createAcceptedEntityTermsRecord();
    const learningProgressRepo: LearningProgressRepository = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-global-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_global',
          entityCui: null,
          isActive: false,
        }),
        createTestNotification({
          id: 'notification-entity-1',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const jobs: ComposeJobPayload[] = [];

    const handler = makeEntityTermsAcceptedUserEventHandler({
      learningProgressRepo,
      notificationsRepo,
      deliveryRepo,
      composeJobScheduler: makeComposeJobScheduler(jobs),
      entityRepo: makeEntityRepo({ '12345678': 'Primaria Test' }),
      logger: pinoLogger({ level: 'silent' }),
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-4',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    const welcome = await deliveryRepo.findByDeliveryKey('campaign_public_debate_welcome:user-1');
    expect(welcome.isOk()).toBe(true);
    if (welcome.isOk()) {
      expect(welcome.value).toBeNull();
    }
    expect(jobs).toHaveLength(0);
  });
});
