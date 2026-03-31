import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { createUserEmailLookupError } from '@/modules/notification-delivery/core/errors.js';
import { processSendJob } from '@/modules/notification-delivery/shell/queue/workers/send-worker.js';

import {
  createTestDeliveryRecord,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeTokenSigner,
} from '../../fixtures/fakes.js';

const testLogger = pinoLogger({ level: 'silent' });

describe('processSendJob', () => {
  it('uses the persisted toEmail snapshot before calling the user email fetcher', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-1',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-1',
          toEmail: 'user@example.com',
          renderedSubject: 'Welcome',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });

    const getEmail = vi.fn(async () => ok('other@example.com'));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));
    const tokenSigner = makeFakeTokenSigner();

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        userEmailFetcher: {
          getEmail,
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner,
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        log: testLogger,
      },
      { outboxId: 'outbox-1' }
    );

    expect(result.status).toBe('sent');
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        notificationType: 'transactional_welcome',
        referenceId: null,
        unsubscribeUrl: `https://api.transparenta.eu/api/v1/notifications/unsubscribe/${tokenSigner.sign('user-1')}`,
      })
    );

    const stored = await deliveryRepo.findById('outbox-1');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('sent');
      expect(stored.value?.toEmail).toBe('user@example.com');
    }
  });

  it('marks delivery as failed_transient and throws on retryable user email lookup errors', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-retry',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-retry',
          renderedSubject: 'Welcome',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });

    const getEmail = vi.fn(async () =>
      err(createUserEmailLookupError('Clerk user lookup rate limited', true))
    );
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    await expect(
      processSendJob(
        {
          deliveryRepo,
          notificationsRepo: makeFakeExtendedNotificationsRepo(),
          userEmailFetcher: {
            getEmail,
            getEmailsByUserIds: vi.fn(async () => ok(new Map())),
          },
          emailSender: { send },
          tokenSigner: makeFakeTokenSigner(),
          apiBaseUrl: 'https://api.transparenta.eu',
          environment: 'test',
          log: testLogger,
        },
        { outboxId: 'outbox-retry' }
      )
    ).rejects.toThrow('Failed to fetch user email: Clerk user lookup rate limited');

    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-retry');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('failed_transient');
      expect(stored.value?.lastError).toBe(
        'Failed to fetch user email: Clerk user lookup rate limited'
      );
    }
  });

  it('marks delivery as failed_permanent on non-retryable user email lookup errors', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-permanent',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-permanent',
          renderedSubject: 'Welcome',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });

    const getEmail = vi.fn(async () =>
      err(createUserEmailLookupError('Clerk user lookup rejected with status 403', false))
    );
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        userEmailFetcher: {
          getEmail,
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner: makeFakeTokenSigner(),
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        log: testLogger,
      },
      { outboxId: 'outbox-permanent' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-permanent',
      status: 'failed_email_fetch',
      error: 'Failed to fetch user email: Clerk user lookup rejected with status 403',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-permanent');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('failed_permanent');
      expect(stored.value?.lastError).toBe(
        'Failed to fetch user email: Clerk user lookup rejected with status 403'
      );
    }
  });

  it('skips delivery when user is globally unsubscribed', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-unsub',
          notificationType: 'newsletter_entity_monthly',
          referenceId: 'notification-1',
          scopeKey: '2026-03',
          deliveryKey: 'user-1:notification-1:2026-03',
          renderedSubject: 'Newsletter',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          globallyUnsubscribedUsers: new Set(['user-1']),
        }),
        userEmailFetcher: {
          getEmail: vi.fn(async () => ok('user@example.com')),
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner: makeFakeTokenSigner(),
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        log: testLogger,
      },
      { outboxId: 'outbox-unsub' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-unsub',
      status: 'skipped_unsubscribed',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-unsub');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });

  it('marks delivery as failed_transient and throws when global unsubscribe lookup fails', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-unsub-check-error',
          notificationType: 'newsletter_entity_monthly',
          referenceId: 'notification-1',
          scopeKey: '2026-03',
          deliveryKey: 'user-1:notification-1:2026-03',
          renderedSubject: 'Newsletter',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    await expect(
      processSendJob(
        {
          deliveryRepo,
          notificationsRepo: makeFakeExtendedNotificationsRepo({ simulateDbError: true }),
          userEmailFetcher: {
            getEmail: vi.fn(async () => ok('user@example.com')),
            getEmailsByUserIds: vi.fn(async () => ok(new Map())),
          },
          emailSender: { send },
          tokenSigner: makeFakeTokenSigner(),
          apiBaseUrl: 'https://api.transparenta.eu',
          environment: 'test',
          log: testLogger,
        },
        { outboxId: 'outbox-unsub-check-error' }
      )
    ).rejects.toThrow('Failed to check global unsubscribe: Simulated database error');

    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-unsub-check-error');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('failed_transient');
      expect(stored.value?.lastError).toBe(
        'Failed to check global unsubscribe: Simulated database error'
      );
    }
  });

  it('marks delivery as skipped_no_email when no verified primary email is available', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-no-email',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-no-email',
          renderedSubject: 'Welcome',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });

    const getEmail = vi.fn(async () => ok(null));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo(),
        userEmailFetcher: {
          getEmail,
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner: makeFakeTokenSigner(),
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        log: testLogger,
      },
      { outboxId: 'outbox-no-email' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-no-email',
      status: 'skipped_no_email',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-no-email');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_no_email');
    }
  });

  it('preserves retryable send failures even when the message lacks heuristic keywords', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-send-retry',
          notificationType: 'newsletter_entity_monthly',
          referenceId: 'notification-1',
          scopeKey: '2026-03',
          deliveryKey: 'user-1:notification-1:2026-03',
          renderedSubject: 'Newsletter',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });

    const send = vi.fn(async () =>
      err({
        type: 'EmailSendError' as const,
        message: 'Provider temporarily unavailable',
        retryable: true,
      })
    );

    await expect(
      processSendJob(
        {
          deliveryRepo,
          notificationsRepo: makeFakeExtendedNotificationsRepo(),
          userEmailFetcher: {
            getEmail: vi.fn(async () => ok('user@example.com')),
            getEmailsByUserIds: vi.fn(async () => ok(new Map())),
          },
          emailSender: { send },
          tokenSigner: makeFakeTokenSigner(),
          apiBaseUrl: 'https://api.transparenta.eu',
          environment: 'test',
          log: testLogger,
        },
        { outboxId: 'outbox-send-retry' }
      )
    ).rejects.toThrow('Provider temporarily unavailable');

    const stored = await deliveryRepo.findById('outbox-send-retry');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('failed_transient');
      expect(stored.value?.lastError).toBe('Provider temporarily unavailable');
    }
  });
});
