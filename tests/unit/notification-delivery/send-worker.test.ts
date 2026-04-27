import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { hashResendTagValue } from '@/common/resend-tag-encoding.js';
import { createUserEmailLookupError } from '@/modules/notification-delivery/core/errors.js';
import { processSendJob } from '@/modules/notification-delivery/shell/queue/workers/send-worker.js';

import {
  createTestNotification,
  createTestDeliveryRecord,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeTokenSigner,
} from '../../fixtures/fakes.js';

const testLogger = pinoLogger({ level: 'silent' });

describe('processSendJob', () => {
  it('skips a claimed delivery when deletion anonymization has started for the user', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      anonymizationStartedUserIds: ['user-1'],
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-anonymizing',
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

    const getEmail = vi.fn(async () => ok('user@example.com'));
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
      { outboxId: 'outbox-anonymizing' }
    );

    expect(result.status).toBe('skipped_no_email');
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-anonymizing');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_no_email');
      expect(stored.value?.lastError).toBe(
        'User deletion anonymization has started; delivery skipped'
      );
    }
  });

  it('fails closed when deletion anonymization state cannot be checked', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      simulateAnonymizationCheckError: true,
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-anonymization-check-error',
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

    const getEmail = vi.fn(async () => ok('user@example.com'));
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
        { outboxId: 'outbox-anonymization-check-error' }
      )
    ).rejects.toThrow('Failed to check user anonymization state before send');

    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-anonymization-check-error');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('failed_transient');
      expect(stored.value?.lastError).toBe(
        'Failed to check user anonymization state before send: Simulated database error'
      );
    }
  });

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
          notificationsRepo: makeFakeExtendedNotificationsRepo({
            notifications: [
              createTestNotification({
                id: 'notification-1',
                userId: 'user-1',
                entityCui: '123',
                notificationType: 'newsletter_entity_monthly',
                isActive: true,
              }),
            ],
          }),
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

  it('refetches the current user email after a replay reset clears a stale snapshot', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-replayed-email',
          notificationType: 'transactional_welcome',
          referenceId: null,
          scopeKey: 'welcome',
          deliveryKey: 'transactional_welcome:user-replayed',
          status: 'failed_transient',
          toEmail: 'stale@example.com',
          renderedSubject: 'Welcome',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          attemptCount: 3,
          resendEmailId: 'resend-old',
        }),
      ],
    });

    const refreshResult = await deliveryRepo.refreshMetadataForRecomposeIfReplayable(
      'outbox-replayed-email',
      {
        eventType: 'thread_started',
        recipientRole: 'subscriber',
      }
    );
    expect(refreshResult.isOk()).toBe(true);
    if (refreshResult.isErr()) {
      return;
    }
    expect(refreshResult.value?.toEmail).toBeNull();

    const composeClaimResult = await deliveryRepo.claimForCompose('outbox-replayed-email');
    expect(composeClaimResult.isOk()).toBe(true);
    if (composeClaimResult.isErr() || composeClaimResult.value === null) {
      return;
    }

    const renderResult = await deliveryRepo.updateRenderedContent('outbox-replayed-email', {
      renderedSubject: 'Welcome',
      renderedHtml: '<p>Hello</p>',
      renderedText: 'Hello',
      contentHash: 'content-hash',
      templateName: 'transactional_welcome',
      templateVersion: '1.0.0',
      expectedComposeClaimId: composeClaimResult.value.metadata['__composeClaimId'] as string,
    });
    expect(renderResult.isOk()).toBe(true);
    if (renderResult.isErr()) {
      return;
    }
    expect(renderResult.value).toBe(true);

    const releaseResult = await deliveryRepo.updateStatusIfCurrentIn(
      'outbox-replayed-email',
      ['composing'],
      'pending'
    );
    expect(releaseResult.isOk()).toBe(true);
    if (releaseResult.isErr()) {
      return;
    }
    expect(releaseResult.value).toBe(true);

    const getEmail = vi.fn(async () => ok('current@example.com'));
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
      { outboxId: 'outbox-replayed-email' }
    );

    expect(result.status).toBe('sent');
    expect(getEmail).toHaveBeenCalledWith('user-1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'current@example.com',
      })
    );

    const stored = await deliveryRepo.findById('outbox-replayed-email');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('sent');
      expect(stored.value?.toEmail).toBe('current@example.com');
      expect(stored.value?.attemptCount).toBe(1);
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

  it('skips direct monthly newsletters when the source notification was deactivated after compose', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-newsletter-inactive',
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
    const getEmail = vi.fn(async () => ok('user@example.com'));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '123',
              notificationType: 'newsletter_entity_monthly',
              isActive: false,
            }),
          ],
        }),
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
      { outboxId: 'outbox-newsletter-inactive' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-newsletter-inactive',
      status: 'skipped_unsubscribed',
    });
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-newsletter-inactive');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });

  it('suppresses direct monthly newsletters when the source was bundled in a digest', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-newsletter-direct',
          notificationType: 'newsletter_entity_monthly',
          referenceId: 'notification-1',
          scopeKey: '2026-03',
          deliveryKey: 'user-1:notification-1:2026-03',
          renderedSubject: 'Newsletter',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
        createTestDeliveryRecord({
          id: 'outbox-digest-existing',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: 'digest:anaf_forexebug:2026-03',
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            sourceNotificationIds: ['notification-1'],
            itemCount: 1,
          },
        }),
      ],
    });
    const getEmail = vi.fn(async () => ok('user@example.com'));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '123',
              notificationType: 'newsletter_entity_monthly',
              isActive: true,
            }),
          ],
        }),
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
      { outboxId: 'outbox-newsletter-direct' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-newsletter-direct',
      status: 'skipped_digest_duplicate',
    });
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-newsletter-direct');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('suppressed');
    }
  });

  it('skips ANAF / Forexebug digests when all source notifications were deactivated after compose', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-digest-inactive',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: 'digest:anaf_forexebug:2026-03',
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          renderedSubject: 'Digest',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            digestType: 'anaf_forexebug_digest',
            sourceNotificationIds: ['notification-1'],
            itemCount: 1,
          },
        }),
      ],
    });
    const getEmail = vi.fn(async () => ok('user@example.com'));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '123',
              notificationType: 'newsletter_entity_monthly',
              isActive: false,
            }),
          ],
        }),
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
      { outboxId: 'outbox-digest-inactive' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-digest-inactive',
      status: 'skipped_unsubscribed',
    });
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('requeues ANAF / Forexebug digest compose when some source notifications are stale', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-digest-partial-stale',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: 'digest:anaf_forexebug:2026-03',
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          renderedSubject: 'Digest',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            runId: 'run-digest',
            digestType: 'anaf_forexebug_digest',
            sourceNotificationIds: ['notification-active', 'notification-inactive'],
            itemCount: 2,
          },
        }),
      ],
    });
    const getEmail = vi.fn(async () => ok('user@example.com'));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));
    const composeJobs: unknown[] = [];

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-active',
              userId: 'user-1',
              entityCui: '123',
              notificationType: 'newsletter_entity_monthly',
              isActive: true,
            }),
            createTestNotification({
              id: 'notification-inactive',
              userId: 'user-1',
              entityCui: '456',
              notificationType: 'newsletter_entity_monthly',
              isActive: false,
            }),
          ],
        }),
        userEmailFetcher: {
          getEmail,
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner: makeFakeTokenSigner(),
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        composeJobScheduler: {
          enqueue: async (job) => {
            composeJobs.push(job);
            return ok(undefined);
          },
        },
        log: testLogger,
      },
      { outboxId: 'outbox-digest-partial-stale' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-digest-partial-stale',
      status: 'requeued_compose_due_to_stale_sources',
    });
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(composeJobs).toEqual([
      {
        runId: 'run-digest',
        kind: 'outbox',
        outboxId: 'outbox-digest-partial-stale',
      },
    ]);

    const stored = await deliveryRepo.findById('outbox-digest-partial-stale');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('pending');
      expect(stored.value?.renderedSubject).toBeNull();
      expect(stored.value?.metadata['sourceNotificationIds']).toEqual(['notification-active']);
      expect(stored.value?.metadata['staleSourceNotificationIds']).toEqual([
        'notification-inactive',
      ]);
    }
  });

  it('requeues ANAF / Forexebug digest compose when an active source changed after compose', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-digest-source-changed',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: 'digest:anaf_forexebug:2026-03',
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          renderedSubject: 'Digest',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            runId: 'run-digest',
            digestType: 'anaf_forexebug_digest',
            sourceNotificationIds: ['notification-1'],
            sourceNotificationVersions: {
              'notification-1': {
                notificationType: 'newsletter_entity_monthly',
                hash: 'old-hash',
              },
            },
            itemCount: 1,
          },
        }),
      ],
    });
    const getEmail = vi.fn(async () => ok('user@example.com'));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));
    const composeJobs: unknown[] = [];

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '123',
              notificationType: 'newsletter_entity_monthly',
              hash: 'new-hash',
              isActive: true,
            }),
          ],
        }),
        userEmailFetcher: {
          getEmail,
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner: makeFakeTokenSigner(),
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        composeJobScheduler: {
          enqueue: async (job) => {
            composeJobs.push(job);
            return ok(undefined);
          },
        },
        log: testLogger,
      },
      { outboxId: 'outbox-digest-source-changed' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-digest-source-changed',
      status: 'requeued_compose_due_to_stale_sources',
    });
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(composeJobs).toHaveLength(1);

    const stored = await deliveryRepo.findById('outbox-digest-source-changed');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('pending');
      expect(stored.value?.metadata['sourceNotificationVersions']).toEqual({
        'notification-1': {
          notificationType: 'newsletter_entity_monthly',
          hash: 'new-hash',
        },
      });
      expect(stored.value?.metadata['changedSourceNotificationIds']).toEqual(['notification-1']);
    }
  });

  it('requeues ANAF / Forexebug digest compose without sources already sent directly', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-digest-direct-sent',
          notificationType: 'anaf_forexebug_digest',
          referenceId: null,
          scopeKey: 'digest:anaf_forexebug:2026-03',
          deliveryKey: 'digest:anaf_forexebug:user-1:2026-03',
          renderedSubject: 'Digest',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            runId: 'run-digest',
            digestType: 'anaf_forexebug_digest',
            sourceNotificationIds: ['notification-direct', 'notification-digest'],
            sourceNotificationVersions: {
              'notification-direct': {
                notificationType: 'newsletter_entity_monthly',
                hash: 'hash-direct',
              },
              'notification-digest': {
                notificationType: 'newsletter_entity_monthly',
                hash: 'hash-digest',
              },
            },
            itemCount: 2,
          },
        }),
        createTestDeliveryRecord({
          id: 'outbox-direct-sent',
          notificationType: 'newsletter_entity_monthly',
          referenceId: 'notification-direct',
          scopeKey: '2026-03',
          deliveryKey: 'user-1:notification-direct:2026-03',
          status: 'sent',
          renderedSubject: 'Newsletter',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
        }),
      ],
    });
    const getEmail = vi.fn(async () => ok('user@example.com'));
    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));
    const composeJobs: unknown[] = [];

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-direct',
              userId: 'user-1',
              entityCui: '123',
              notificationType: 'newsletter_entity_monthly',
              hash: 'hash-direct',
              isActive: true,
            }),
            createTestNotification({
              id: 'notification-digest',
              userId: 'user-1',
              entityCui: '456',
              notificationType: 'newsletter_entity_monthly',
              hash: 'hash-digest',
              isActive: true,
            }),
          ],
        }),
        userEmailFetcher: {
          getEmail,
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner: makeFakeTokenSigner(),
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        composeJobScheduler: {
          enqueue: async (job) => {
            composeJobs.push(job);
            return ok(undefined);
          },
        },
        log: testLogger,
      },
      { outboxId: 'outbox-digest-direct-sent' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-digest-direct-sent',
      status: 'requeued_compose_due_to_stale_sources',
    });
    expect(getEmail).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(composeJobs).toHaveLength(1);

    const stored = await deliveryRepo.findById('outbox-digest-direct-sent');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.metadata['sourceNotificationIds']).toEqual(['notification-digest']);
      expect(stored.value?.metadata['staleSourceNotificationIds']).toEqual(['notification-direct']);
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
          notificationsRepo: makeFakeExtendedNotificationsRepo({
            notifications: [
              createTestNotification({
                id: 'notification-1',
                userId: 'user-1',
                entityCui: '123',
                notificationType: 'newsletter_entity_monthly',
                isActive: true,
              }),
            ],
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

  it('skips reviewed-interaction delivery when entity updates were disabled after enqueue', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-reviewed-optout',
          notificationType: 'funky:outbox:admin_reviewed_interaction',
          referenceId: 'notification-1',
          scopeKey:
            'reviewed_interaction:funky:user-1:funky:interaction:budget_document:record-1:2026-04-13T12:00:00.000Z:rejected',
          deliveryKey:
            'reviewed_interaction:funky:user-1:funky:interaction:budget_document:record-1:2026-04-13T12:00:00.000Z:rejected',
          renderedSubject: 'Reviewed interaction',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            campaignKey: 'funky',
            familyId: 'admin_reviewed_interaction',
            recordKey: 'record-1',
            interactionId: 'funky:interaction:budget_document',
            interactionLabel: 'Document buget',
            reviewStatus: 'rejected',
            reviewedAt: '2026-04-13T12:00:00.000Z',
            feedbackText: 'Documentul trimis nu este suficient de clar.',
            userId: 'user-1',
            entityCui: '12345678',
            entityName: 'Municipiul Exemplu',
          },
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '12345678',
              notificationType: 'funky:notification:entity_updates',
              isActive: true,
            }),
            createTestNotification({
              id: 'notification-global',
              userId: 'user-1',
              entityCui: null,
              notificationType: 'funky:notification:global',
              isActive: false,
            }),
          ],
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
      { outboxId: 'outbox-reviewed-optout' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-reviewed-optout',
      status: 'skipped_unsubscribed',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-reviewed-optout');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });

  it('skips admin-response deliveries when the campaign entity preference is disabled after enqueue', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-admin-response-optout',
          notificationType: 'funky:outbox:admin_response',
          referenceId: 'notification-1',
          renderedSubject: 'Admin response',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            campaignKey: 'funky',
            familyId: 'public_debate_admin_response',
            eventType: 'admin_response_added',
            entityCui: '12345678',
            entityName: 'Municipiul Exemplu',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            responseEventId: 'response-1',
            responseStatus: 'request_confirmed',
            responseDate: '2026-04-16T10:00:00.000Z',
            messageContent: 'Solicitarea a fost confirmată.',
            recipientRole: 'subscriber',
          },
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '12345678',
              notificationType: 'funky:notification:entity_updates',
              isActive: true,
            }),
            createTestNotification({
              id: 'notification-global',
              userId: 'user-1',
              entityCui: null,
              notificationType: 'funky:notification:global',
              isActive: false,
            }),
          ],
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
      { outboxId: 'outbox-admin-response-optout' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-admin-response-optout',
      status: 'skipped_unsubscribed',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-admin-response-optout');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });

  it('skips admin-response delivery when entity updates were disabled after enqueue', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-admin-response-optout',
          notificationType: 'funky:outbox:admin_response',
          referenceId: 'notification-1',
          scopeKey: 'funky:delivery:admin_response_thread-1_response-1',
          deliveryKey: 'user-1:notification-1:funky:delivery:admin_response_thread-1_response-1',
          renderedSubject: 'Admin response',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            campaignKey: 'funky',
            familyId: 'public_debate_admin_response',
            eventType: 'admin_response_added',
            entityCui: '12345678',
            entityName: 'Municipiul Exemplu',
            threadId: 'thread-1',
            threadKey: 'thread-key-1',
            responseEventId: 'response-1',
            responseStatus: 'registration_number_received',
            responseDate: '2026-04-16T10:00:00.000Z',
            messageContent: 'Am înregistrat solicitarea.',
            recipientRole: 'requester',
          },
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '12345678',
              notificationType: 'funky:notification:entity_updates',
              isActive: true,
            }),
            createTestNotification({
              id: 'notification-global',
              userId: 'user-1',
              entityCui: null,
              notificationType: 'funky:notification:global',
              isActive: false,
            }),
          ],
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
      { outboxId: 'outbox-admin-response-optout' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-admin-response-optout',
      status: 'skipped_unsubscribed',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-admin-response-optout');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });

  it('skips public debate announcement delivery when entity updates were disabled after enqueue', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-public-debate-announcement-optout',
          notificationType: 'funky:outbox:public_debate_announcement',
          referenceId: 'notification-1',
          scopeKey: 'funky:delivery:public_debate_announcement:12345678:fingerprint-1',
          deliveryKey: 'user-1:12345678:fingerprint-1',
          renderedSubject: 'Public debate announcement',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            campaignKey: 'funky',
            familyId: 'public_debate_announcement',
            entityCui: '12345678',
            entityName: 'Municipiul Exemplu',
            publicDebate: {
              date: '2099-05-10',
              time: '18:00',
              location: 'Council Hall',
              announcement_link: 'https://example.com/public-debate',
            },
            announcementFingerprint: 'fingerprint-1',
            configUpdatedAt: '2026-05-01T12:00:00.000Z',
          },
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '12345678',
              notificationType: 'funky:notification:entity_updates',
              isActive: true,
            }),
            createTestNotification({
              id: 'notification-global',
              userId: 'user-1',
              entityCui: null,
              notificationType: 'funky:notification:global',
              isActive: false,
            }),
          ],
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
      { outboxId: 'outbox-public-debate-announcement-optout' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-public-debate-announcement-optout',
      status: 'skipped_unsubscribed',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-public-debate-announcement-optout');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });

  it('skips Bucharest budget analysis delivery when Bucharest updates were disabled after enqueue', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-bucharest-analysis-optout',
          notificationType: 'funky:outbox:bucharest_budget_analysis',
          referenceId: 'notification-1',
          scopeKey: 'funky:delivery:bucharest_budget_analysis:4267117:fingerprint-1',
          deliveryKey: 'funky:delivery:bucharest_budget_analysis:user-1:4267117:fingerprint-1',
          renderedSubject: 'Bucharest budget analysis',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            campaignKey: 'funky',
            familyId: 'bucharest_budget_analysis',
            entityCui: '4267117',
            entityName: 'Primăria Municipiului București',
            analysisId: 'pmb-budget-analysis-2026',
            analysisUrl:
              'https://funky.ong/analiza-buget-local-primaria-municipiului-bucuresti-2026/',
            analysisPublishedAt: '2026-04-23',
            analysisFingerprint: 'fingerprint-1',
          },
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '4267117',
              notificationType: 'funky:notification:entity_updates',
              isActive: false,
            }),
          ],
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
      { outboxId: 'outbox-bucharest-analysis-optout' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-bucharest-analysis-optout',
      status: 'skipped_unsubscribed',
    });
    expect(send).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-bucharest-analysis-optout');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });

  it('skips public debate announcement delivery when the debate already took place', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T15:01:00.000Z'));

    try {
      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [
          createTestDeliveryRecord({
            id: 'outbox-public-debate-announcement-past',
            notificationType: 'funky:outbox:public_debate_announcement',
            referenceId: 'notification-1',
            scopeKey: 'funky:delivery:public_debate_announcement:12345678:fingerprint-1',
            deliveryKey: 'user-1:12345678:fingerprint-1',
            renderedSubject: 'Public debate announcement',
            renderedHtml: '<p>Hello</p>',
            renderedText: 'Hello',
            metadata: {
              campaignKey: 'funky',
              familyId: 'public_debate_announcement',
              entityCui: '12345678',
              entityName: 'Municipiul Exemplu',
              publicDebate: {
                date: '2026-05-10',
                time: '18:00',
                location: 'Council Hall',
                announcement_link: 'https://example.com/public-debate',
              },
              announcementFingerprint: 'fingerprint-1',
              configUpdatedAt: '2026-05-01T12:00:00.000Z',
            },
          }),
        ],
      });

      const send = vi.fn(async () => ok({ emailId: 'mock-1' }));
      const getEmail = vi.fn(async () => ok('user@example.com'));

      const result = await processSendJob(
        {
          deliveryRepo,
          notificationsRepo: makeFakeExtendedNotificationsRepo({
            notifications: [
              createTestNotification({
                id: 'notification-1',
                userId: 'user-1',
                entityCui: '12345678',
                notificationType: 'funky:notification:entity_updates',
                isActive: true,
              }),
            ],
          }),
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
        { outboxId: 'outbox-public-debate-announcement-past' }
      );

      expect(result).toEqual({
        outboxId: 'outbox-public-debate-announcement-past',
        status: 'skipped_unsubscribed',
      });
      expect(getEmail).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();

      const stored = await deliveryRepo.findById('outbox-public-debate-announcement-past');
      expect(stored.isOk()).toBe(true);
      if (stored.isOk()) {
        expect(stored.value?.status).toBe('skipped_unsubscribed');
        expect(stored.value?.lastError).toBe(
          'Public debate announcement already took place at send time.'
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('hashes the scope_key provider tag for reviewed-interaction deliveries', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-reviewed-tags',
          notificationType: 'funky:outbox:admin_reviewed_interaction',
          referenceId: 'notification-1',
          scopeKey:
            'reviewed_interaction:funky:user-1:funky:interaction:budget_document:record-1:2026-04-13T12:00:00.000Z:rejected',
          deliveryKey:
            'reviewed_interaction:funky:user-1:funky:interaction:budget_document:record-1:2026-04-13T12:00:00.000Z:rejected',
          renderedSubject: 'Reviewed interaction',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            campaignKey: 'funky',
            familyId: 'admin_reviewed_interaction',
            recordKey: 'record-1',
            interactionId: 'funky:interaction:budget_document',
            interactionLabel: 'Document buget',
            reviewStatus: 'rejected',
            reviewedAt: '2026-04-13T12:00:00.000Z',
            feedbackText: 'Documentul trimis nu este suficient de clar.',
            userId: 'user-1',
            entityCui: '12345678',
            entityName: 'Municipiul Exemplu',
          },
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));
    const scopeKey =
      'reviewed_interaction:funky:user-1:funky:interaction:budget_document:record-1:2026-04-13T12:00:00.000Z:rejected';

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notification-1',
              userId: 'user-1',
              entityCui: '12345678',
              notificationType: 'funky:notification:entity_updates',
              isActive: true,
            }),
          ],
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
      { outboxId: 'outbox-reviewed-tags' }
    );

    expect(result.status).toBe('sent');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining([
          {
            name: 'scope_key',
            value: hashResendTagValue(scopeKey),
          },
        ]),
      })
    );
  });
});
