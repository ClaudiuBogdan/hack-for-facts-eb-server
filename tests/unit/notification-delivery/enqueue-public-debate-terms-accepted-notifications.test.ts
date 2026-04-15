import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { enqueuePublicDebateTermsAcceptedNotifications } from '@/modules/notification-delivery/index.js';

import {
  createTestDeliveryRecord,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';

import type { DeliveryError } from '@/modules/notification-delivery/core/errors.js';
import type {
  ComposeJobScheduler,
  DeliveryRepository,
} from '@/modules/notification-delivery/core/ports.js';
import type { ComposeJobPayload } from '@/modules/notification-delivery/core/types.js';

const makeComposeJobScheduler = (jobs: ComposeJobPayload[]): ComposeJobScheduler => ({
  async enqueue(job) {
    jobs.push(job);
    return ok(undefined);
  },
});

const makeInput = (
  overrides: Partial<Parameters<typeof enqueuePublicDebateTermsAcceptedNotifications>[1]> = {}
) => ({
  runId: 'run-1',
  source: 'funky:source:terms_accepted',
  sourceEventId: 'event-1',
  userId: 'user-1',
  campaignKey: 'funky' as const,
  entityCui: '12345678',
  entityName: 'Primaria Test',
  acceptedTermsAt: '2026-04-01T10:00:00.000Z',
  globalPreferenceId: 'notification-global-1',
  globalPreferenceActive: true,
  entitySubscriptionId: 'notification-entity-1',
  entitySubscriptionActive: true,
  ...overrides,
});

describe('enqueuePublicDebateTermsAcceptedNotifications', () => {
  it('deduplicates the first public debate welcome email per user', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo();
    const queuedJobs: ComposeJobPayload[] = [];
    const composeJobScheduler = makeComposeJobScheduler(queuedJobs);

    const first = await enqueuePublicDebateTermsAcceptedNotifications(
      { notificationsRepo, deliveryRepo, composeJobScheduler },
      makeInput()
    );
    const second = await enqueuePublicDebateTermsAcceptedNotifications(
      { notificationsRepo, deliveryRepo, composeJobScheduler },
      makeInput({ runId: 'run-2', sourceEventId: 'event-2' })
    );

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    if (first.isOk() && second.isOk()) {
      expect(first.value.status).toBe('welcome_created');
      expect(first.value.created).toBe(true);
      expect(second.value.status).toBe('welcome_reused');
      expect(second.value.created).toBe(false);
      expect(second.value.requeued).toBe(true);
      expect(second.value.outbox?.id).toBe(first.value.outbox?.id);
    }

    const welcome = await deliveryRepo.findByDeliveryKey('funky:outbox:welcome:user-1');
    const entitySubscription = await deliveryRepo.findByDeliveryKey(
      'funky:outbox:entity_subscription:user-1:12345678'
    );

    expect(welcome.isOk()).toBe(true);
    expect(entitySubscription.isOk()).toBe(true);
    if (welcome.isOk() && entitySubscription.isOk()) {
      expect(welcome.value?.notificationType).toBe('funky:outbox:welcome');
      expect(entitySubscription.value).toBeNull();
    }

    expect(queuedJobs).toHaveLength(2);
    if (first.isOk()) {
      expect(queuedJobs[0]).toEqual({
        runId: 'run-1',
        kind: 'outbox',
        outboxId: first.value.outbox?.id,
      });
      expect(queuedJobs[1]).toEqual({
        runId: 'run-2',
        kind: 'outbox',
        outboxId: first.value.outbox?.id,
      });
    }
  });

  it('creates and deduplicates entity subscription confirmations per user and entity', async () => {
    const existingWelcome = createTestDeliveryRecord({
      id: 'outbox-welcome-1',
      notificationType: 'funky:outbox:welcome',
      referenceId: 'notification-global-1',
      scopeKey: 'funky:delivery:welcome',
      deliveryKey: 'funky:outbox:welcome:user-1',
      status: 'delivered',
      metadata: {
        campaignKey: 'funky',
        entityCui: '11111111',
        entityName: 'Prima Entitate',
        acceptedTermsAt: '2026-04-01T10:00:00.000Z',
      },
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingWelcome] });
    const notificationsRepo = makeFakeExtendedNotificationsRepo();
    const queuedJobs: ComposeJobPayload[] = [];
    const composeJobScheduler = makeComposeJobScheduler(queuedJobs);

    const first = await enqueuePublicDebateTermsAcceptedNotifications(
      { notificationsRepo, deliveryRepo, composeJobScheduler },
      makeInput({
        entityCui: '87654321',
        entityName: 'A Doua Entitate',
        selectedEntities: ['A Doua Entitate', 'Prima Entitate'],
        entitySubscriptionId: 'notification-entity-2',
      })
    );
    const second = await enqueuePublicDebateTermsAcceptedNotifications(
      { notificationsRepo, deliveryRepo, composeJobScheduler },
      makeInput({
        runId: 'run-2',
        sourceEventId: 'event-2',
        entityCui: '87654321',
        entityName: 'A Doua Entitate',
        selectedEntities: ['A Doua Entitate', 'Prima Entitate'],
        entitySubscriptionId: 'notification-entity-2',
      })
    );

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    if (first.isOk() && second.isOk()) {
      expect(first.value.status).toBe('entity_subscription_created');
      expect(second.value.status).toBe('entity_subscription_reused');
      expect(second.value.created).toBe(false);
      expect(second.value.outbox?.id).toBe(first.value.outbox?.id);
    }

    const entitySubscription = await deliveryRepo.findByDeliveryKey(
      'funky:outbox:entity_subscription:user-1:87654321'
    );
    expect(entitySubscription.isOk()).toBe(true);
    if (entitySubscription.isOk()) {
      expect(entitySubscription.value?.notificationType).toBe('funky:outbox:entity_subscription');
      expect(entitySubscription.value?.metadata['selectedEntities']).toEqual([
        'A Doua Entitate',
        'Prima Entitate',
      ]);
    }
    expect(queuedJobs).toHaveLength(2);
  });

  it('re-enqueues an existing pending welcome outbox row instead of creating a duplicate', async () => {
    const existingWelcome = createTestDeliveryRecord({
      id: 'outbox-welcome-pending',
      notificationType: 'funky:outbox:welcome',
      referenceId: 'notification-global-1',
      scopeKey: 'funky:delivery:welcome',
      deliveryKey: 'funky:outbox:welcome:user-1',
      status: 'pending',
      renderedSubject: 'Already rendered',
      renderedHtml: '<p>existing</p>',
      renderedText: 'existing',
      templateName: 'public_debate_campaign_welcome',
      templateVersion: '1.0.0',
      metadata: {
        campaignKey: 'funky',
        entityCui: '12345678',
        entityName: 'Primaria Test',
        acceptedTermsAt: '2026-04-01T10:00:00.000Z',
      },
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingWelcome] });
    const notificationsRepo = makeFakeExtendedNotificationsRepo();
    const queuedJobs: ComposeJobPayload[] = [];

    const result = await enqueuePublicDebateTermsAcceptedNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: makeComposeJobScheduler(queuedJobs),
      },
      makeInput()
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('welcome_reused');
      expect(result.value.created).toBe(false);
      expect(result.value.requeued).toBe(true);
      expect(result.value.outbox?.id).toBe('outbox-welcome-pending');
    }
    expect(queuedJobs).toEqual([
      {
        runId: 'run-1',
        kind: 'outbox',
        outboxId: 'outbox-welcome-pending',
      },
    ]);
  });

  it('handles duplicate entity subscription creation races by loading the existing row', async () => {
    const existingWelcome = createTestDeliveryRecord({
      id: 'outbox-welcome-1',
      notificationType: 'funky:outbox:welcome',
      referenceId: 'notification-global-1',
      scopeKey: 'funky:delivery:welcome',
      deliveryKey: 'funky:outbox:welcome:user-1',
      status: 'delivered',
      metadata: {
        campaignKey: 'funky',
        entityCui: '11111111',
        entityName: 'Prima Entitate',
        acceptedTermsAt: '2026-04-01T10:00:00.000Z',
      },
    });
    const existingEntitySubscription = createTestDeliveryRecord({
      id: 'outbox-entity-pending',
      notificationType: 'funky:outbox:entity_subscription',
      referenceId: 'notification-entity-2',
      scopeKey: 'funky:delivery:entity_subscription_87654321',
      deliveryKey: 'funky:outbox:entity_subscription:user-1:87654321',
      status: 'pending',
      renderedSubject: 'Existing',
      renderedHtml: '<p>existing</p>',
      renderedText: 'existing',
      templateName: 'public_debate_entity_subscription',
      templateVersion: '1.0.0',
      metadata: {
        campaignKey: 'funky',
        entityCui: '87654321',
        entityName: 'A Doua Entitate',
        acceptedTermsAt: '2026-04-02T11:00:00.000Z',
      },
    });
    const baseRepo = makeFakeDeliveryRepo({
      deliveries: [existingWelcome, existingEntitySubscription],
    });
    let firstLookup = true;
    const deliveryKey = 'funky:outbox:entity_subscription:user-1:87654321';
    const deliveryRepo: DeliveryRepository = {
      ...baseRepo,
      async findByDeliveryKey(candidateKey) {
        if (candidateKey === deliveryKey && firstLookup) {
          firstLookup = false;
          return ok(null);
        }

        return baseRepo.findByDeliveryKey(candidateKey);
      },
      async create(input) {
        if (input.deliveryKey === deliveryKey) {
          return err({
            type: 'DuplicateDelivery',
            deliveryKey,
          } as DeliveryError);
        }

        return baseRepo.create(input);
      },
    };
    const queuedJobs: ComposeJobPayload[] = [];
    const notificationsRepo = makeFakeExtendedNotificationsRepo();

    const result = await enqueuePublicDebateTermsAcceptedNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: makeComposeJobScheduler(queuedJobs),
      },
      makeInput({
        entityCui: '87654321',
        entityName: 'A Doua Entitate',
        entitySubscriptionId: 'notification-entity-2',
      })
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('entity_subscription_reused');
      expect(result.value.created).toBe(false);
      expect(result.value.requeued).toBe(true);
      expect(result.value.outbox?.id).toBe('outbox-entity-pending');
    }
    expect(queuedJobs).toEqual([
      {
        runId: 'run-1',
        kind: 'outbox',
        outboxId: 'outbox-entity-pending',
      },
    ]);
  });

  it('skips campaign welcome and entity subscription emails for globally unsubscribed users', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      globallyUnsubscribedUsers: new Set(['user-1']),
    });
    const queuedJobs: ComposeJobPayload[] = [];

    const result = await enqueuePublicDebateTermsAcceptedNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: makeComposeJobScheduler(queuedJobs),
      },
      makeInput()
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('skipped_global_unsubscribe');
      expect(result.value.outbox).toBeNull();
      expect(result.value.created).toBe(false);
      expect(result.value.requeued).toBe(false);
    }

    const welcome = await deliveryRepo.findByDeliveryKey('funky:outbox:welcome:user-1');
    const entitySubscription = await deliveryRepo.findByDeliveryKey(
      'funky:outbox:entity_subscription:user-1:12345678'
    );

    expect(welcome.isOk()).toBe(true);
    expect(entitySubscription.isOk()).toBe(true);
    if (welcome.isOk() && entitySubscription.isOk()) {
      expect(welcome.value).toBeNull();
      expect(entitySubscription.value).toBeNull();
    }
    expect(queuedJobs).toEqual([]);
  });
});
