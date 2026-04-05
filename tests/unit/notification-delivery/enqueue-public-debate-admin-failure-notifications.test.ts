import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createQueueError } from '@/modules/notification-delivery/core/errors.js';
import { enqueuePublicDebateAdminFailureNotifications } from '@/modules/notification-delivery/index.js';

import { makeFakeDeliveryRepo } from '../../fixtures/fakes.js';

describe('enqueuePublicDebateAdminFailureNotifications', () => {
  const createComposeJobScheduler = () => ({
    enqueue: vi.fn(async () => ok(undefined)),
  });

  it('creates one outbox row per admin recipient with direct toEmail delivery', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = createComposeJobScheduler();

    const result = await enqueuePublicDebateAdminFailureNotifications(
      {
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-admin-1',
        recipientEmails: ['admin-one@example.com', 'admin-two@example.com'],
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'failed',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Municipiul Exemplu',
        occurredAt: '2026-04-03T10:00:00.000Z',
        failureMessage: 'Provider returned 422 validation_error',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.recipientEmails).toEqual([
        'admin-one@example.com',
        'admin-two@example.com',
      ]);
      expect(result.value.createdOutboxIds).toHaveLength(2);
      expect(result.value.enqueueFailedOutboxIds).toEqual([]);
      expect(result.value.queuedOutboxIds).toHaveLength(2);
    }

    const outbox = await deliveryRepo.findByDeliveryKey(
      'admin:admin-one@example.com:admin_failure:thread-1'
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.notificationType).toBe('funky:outbox:admin_failure');
      expect(outbox.value?.toEmail).toBe('admin-one@example.com');
      expect(outbox.value?.referenceId).toBeNull();
      expect(outbox.value?.metadata).toEqual(
        expect.objectContaining({
          entityCui: '12345678',
          entityName: 'Municipiul Exemplu',
          threadId: 'thread-1',
          institutionEmail: 'contact@primarie.ro',
          failureMessage: 'Provider returned 422 validation_error',
        })
      );
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(2);
  });

  it('deduplicates recipients and reuses an existing deterministic outbox row', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();

    const firstResult = await enqueuePublicDebateAdminFailureNotifications(
      {
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-admin-1',
        recipientEmails: ['admin@example.com', 'ADMIN@example.com'],
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'failed',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Municipiul Exemplu',
        occurredAt: '2026-04-03T10:00:00.000Z',
        failureMessage: 'Provider returned 422 validation_error',
      }
    );
    const secondResult = await enqueuePublicDebateAdminFailureNotifications(
      {
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-admin-2',
        recipientEmails: ['admin@example.com'],
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'failed',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Municipiul Exemplu',
        occurredAt: '2026-04-03T10:00:00.000Z',
        failureMessage: 'Provider returned 422 validation_error',
      }
    );

    expect(firstResult.isOk()).toBe(true);
    expect(secondResult.isOk()).toBe(true);
    if (firstResult.isOk()) {
      expect(firstResult.value.recipientEmails).toEqual(['admin@example.com']);
    }
    if (secondResult.isOk()) {
      expect(secondResult.value.createdOutboxIds).toEqual([]);
      expect(secondResult.value.reusedOutboxIds).toHaveLength(1);
    }
  });

  it('records compose enqueue failures without failing the outbox creation', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueuePublicDebateAdminFailureNotifications(
      {
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async () => err(createQueueError('queue down', true)),
        },
      },
      {
        runId: 'run-admin-fail',
        recipientEmails: ['admin@example.com'],
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'failed',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Municipiul Exemplu',
        occurredAt: '2026-04-03T10:00:00.000Z',
        failureMessage: 'Provider returned 422 validation_error',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.createdOutboxIds).toHaveLength(1);
      expect(result.value.enqueueFailedOutboxIds).toHaveLength(1);
      expect(result.value.queuedOutboxIds).toEqual([]);
    }
  });

  it('returns none when no admin recipients are configured', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueuePublicDebateAdminFailureNotifications(
      {
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-admin-empty',
        recipientEmails: [],
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'failed',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Municipiul Exemplu',
        occurredAt: '2026-04-03T10:00:00.000Z',
        failureMessage: 'Provider returned 422 validation_error',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.recipientEmails).toEqual([]);
      expect(result.value.createdOutboxIds).toEqual([]);
      expect(result.value.reusedOutboxIds).toEqual([]);
      expect(result.value.queuedOutboxIds).toEqual([]);
    }
  });
});
