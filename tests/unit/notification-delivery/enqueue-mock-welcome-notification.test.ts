import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  createDatabaseError,
  enqueueTransactionalWelcomeNotification,
} from '@/modules/notification-delivery/index.js';

import { createTestDeliveryRecord, makeFakeDeliveryRepo } from '../../fixtures/fakes.js';

import type { ComposeJobPayload } from '@/modules/notification-delivery/core/types.js';

const makeComposeJobScheduler = (
  jobs: ComposeJobPayload[],
  options: { failFirst?: boolean } = {}
) => {
  const queuedJobIds = new Set<string>();
  let enqueueAttempts = 0;

  return {
    async enqueue(job: ComposeJobPayload) {
      enqueueAttempts += 1;

      if (options.failFirst === true && enqueueAttempts === 1) {
        return err(createDatabaseError('Queue unavailable'));
      }

      const jobId =
        job.kind === 'outbox'
          ? `compose-outbox-${job.outboxId}`
          : `compose-${job.notificationId}-${job.periodKey}`;

      if (!queuedJobIds.has(jobId)) {
        queuedJobIds.add(jobId);
        jobs.push(job);
      }

      return ok(undefined);
    },
  };
};

describe('enqueueTransactionalWelcomeNotification', () => {
  it('deduplicates repeated registration events for the same user', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const queuedJobs: ComposeJobPayload[] = [];

    const composeJobScheduler = makeComposeJobScheduler(queuedJobs);

    const first = await enqueueTransactionalWelcomeNotification(
      { deliveryRepo, composeJobScheduler },
      {
        runId: 'run-1',
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-1',
        userId: 'user-1',
        email: 'user@example.com',
        registeredAt: '2026-03-28T12:00:00.000Z',
      }
    );

    const second = await enqueueTransactionalWelcomeNotification(
      { deliveryRepo, composeJobScheduler },
      {
        runId: 'run-2',
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-2',
        userId: 'user-1',
        email: 'user@example.com',
        registeredAt: '2026-03-28T12:05:00.000Z',
      }
    );

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    if (first.isOk() && second.isOk()) {
      expect(first.value.created).toBe(true);
      expect(second.value.created).toBe(false);
      expect(second.value.outbox.id).toBe(first.value.outbox.id);
      expect(first.value.outbox.notificationType).toBe('transactional_welcome');
      expect(first.value.outbox.referenceId).toBeNull();
      expect(first.value.outbox.scopeKey).toBe('welcome');
      expect(first.value.outbox.toEmail).toBe('user@example.com');
      expect(first.value.outbox.metadata).toEqual({
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-1',
        registeredAt: '2026-03-28T12:00:00.000Z',
      });
    }

    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toEqual({
      runId: 'run-1',
      kind: 'outbox',
      outboxId: first._unsafeUnwrap().outbox.id,
    });
  });

  it('re-enqueues an existing incomplete welcome outbox after an initial queue failure', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const queuedJobs: ComposeJobPayload[] = [];
    const composeJobScheduler = makeComposeJobScheduler(queuedJobs, { failFirst: true });

    const first = await enqueueTransactionalWelcomeNotification(
      { deliveryRepo, composeJobScheduler },
      {
        runId: 'run-1',
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-1',
        userId: 'user-1',
        email: 'user@example.com',
        registeredAt: '2026-03-28T12:00:00.000Z',
      }
    );

    expect(first.isErr()).toBe(true);

    const second = await enqueueTransactionalWelcomeNotification(
      { deliveryRepo, composeJobScheduler },
      {
        runId: 'run-2',
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-2',
        userId: 'user-1',
        email: 'user@example.com',
        registeredAt: '2026-03-28T12:05:00.000Z',
      }
    );

    expect(second.isOk()).toBe(true);

    if (second.isOk()) {
      expect(second.value.created).toBe(false);
      expect(second.value.outbox.status).toBe('pending');
      expect(second.value.outbox.renderedSubject).toBeNull();
      expect(second.value.outbox.renderedHtml).toBeNull();
      expect(second.value.outbox.renderedText).toBeNull();
    }

    expect(queuedJobs).toEqual([
      {
        runId: 'run-2',
        kind: 'outbox',
        outboxId: second._unsafeUnwrap().outbox.id,
      },
    ]);
  });

  it('re-enqueues a pending welcome outbox even after content was already rendered', async () => {
    const existingOutbox = createTestDeliveryRecord({
      id: 'outbox-1',
      notificationType: 'transactional_welcome',
      referenceId: null,
      scopeKey: 'welcome',
      deliveryKey: 'transactional_welcome:user-1',
      status: 'pending',
      renderedSubject: 'Welcome',
      renderedHtml: '<p>Hello</p>',
      renderedText: 'Hello',
      templateName: 'welcome',
      templateVersion: '1.0.0',
      toEmail: 'user@example.com',
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingOutbox] });
    const queuedJobs: ComposeJobPayload[] = [];
    const composeJobScheduler = makeComposeJobScheduler(queuedJobs);

    const result = await enqueueTransactionalWelcomeNotification(
      { deliveryRepo, composeJobScheduler },
      {
        runId: 'run-2',
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-2',
        userId: 'user-1',
        email: 'user@example.com',
        registeredAt: '2026-03-28T12:05:00.000Z',
      }
    );

    expect(result.isOk()).toBe(true);

    if (result.isOk()) {
      expect(result.value.created).toBe(false);
      expect(result.value.outbox.id).toBe('outbox-1');
      expect(result.value.outbox.status).toBe('pending');
      expect(result.value.outbox.renderedSubject).toBe('Welcome');
    }

    expect(queuedJobs).toEqual([
      {
        runId: 'run-2',
        kind: 'outbox',
        outboxId: 'outbox-1',
      },
    ]);
  });

  it('does not re-enqueue a sent welcome outbox row', async () => {
    const existingOutbox = createTestDeliveryRecord({
      id: 'outbox-1',
      notificationType: 'transactional_welcome',
      referenceId: null,
      scopeKey: 'welcome',
      deliveryKey: 'transactional_welcome:user-1',
      status: 'sent',
      renderedSubject: 'Welcome',
      renderedHtml: '<p>Hello</p>',
      renderedText: 'Hello',
      templateName: 'welcome',
      templateVersion: '1.0.0',
      toEmail: 'user@example.com',
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingOutbox] });
    const queuedJobs: ComposeJobPayload[] = [];
    const composeJobScheduler = makeComposeJobScheduler(queuedJobs);

    const result = await enqueueTransactionalWelcomeNotification(
      { deliveryRepo, composeJobScheduler },
      {
        runId: 'run-2',
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-2',
        userId: 'user-1',
        email: 'user@example.com',
        registeredAt: '2026-03-28T12:05:00.000Z',
      }
    );

    expect(result.isOk()).toBe(true);

    if (result.isOk()) {
      expect(result.value.created).toBe(false);
      expect(result.value.outbox.id).toBe('outbox-1');
    }

    expect(queuedJobs).toEqual([]);
  });

  it('allows email to be omitted so send-time lookup can resolve it later', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const queuedJobs: ComposeJobPayload[] = [];
    const composeJobScheduler = makeComposeJobScheduler(queuedJobs);

    const result = await enqueueTransactionalWelcomeNotification(
      { deliveryRepo, composeJobScheduler },
      {
        runId: 'run-3',
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-3',
        userId: 'user-2',
        registeredAt: '2026-03-28T12:10:00.000Z',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.created).toBe(true);
      expect(result.value.outbox.toEmail).toBeNull();
      expect(result.value.outbox.metadata).toEqual({
        source: 'clerk_webhook.user_created',
        sourceEventId: 'evt-3',
        registeredAt: '2026-03-28T12:10:00.000Z',
      });
    }
  });
});
