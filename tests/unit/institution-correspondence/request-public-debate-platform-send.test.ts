import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createConflictError,
  requestPublicDebatePlatformSend,
  makePublicDebateTemplateRenderer,
} from '@/modules/institution-correspondence/index.js';

import {
  makeInMemoryCorrespondenceRepo,
  createThreadAggregateRecord,
  createThreadRecord,
} from './fake-repo.js';

describe('requestPublicDebatePlatformSend', () => {
  it('ensures the subscription before sending a new platform request', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const ensureSubscribed = vi.fn(async () => ok(undefined));
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));

    const result = await requestPublicDebatePlatformSend(
      {
        repo,
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          send,
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: ['audit@transparenta.test'],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
        subscriptionService: {
          ensureSubscribed,
        },
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(ensureSubscribed).toHaveBeenCalledWith('user-1', '12345678');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns an existing non-failed platform thread without sending a duplicate email', async () => {
    const existingThread = createThreadRecord({
      entityCui: '12345678',
      phase: 'awaiting_reply',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [existingThread],
    });
    const ensureSubscribed = vi.fn(async () => ok(undefined));
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));

    const result = await requestPublicDebatePlatformSend(
      {
        repo,
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          send,
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: [],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
        subscriptionService: {
          ensureSubscribed,
        },
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.created).toBe(false);
      expect(result.value.thread.id).toBe(existingThread.id);
    }
    expect(ensureSubscribed).toHaveBeenCalledWith('user-1', '12345678');
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a correspondence error when ensuring the subscription fails', async () => {
    const repo = makeInMemoryCorrespondenceRepo();

    const result = await requestPublicDebatePlatformSend(
      {
        repo,
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          async send() {
            return ok({ emailId: 'email-1' });
          },
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: [],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
        subscriptionService: {
          async ensureSubscribed() {
            return err({
              type: 'CorrespondenceDatabaseError',
              message: 'subscription failed',
              retryable: true,
            });
          },
        },
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('CorrespondenceDatabaseError');
      expect(result.error.message).toBe('subscription failed');
    }
  });

  it('reloads and returns the existing thread when createThread races with another platform send', async () => {
    const existingThread = createThreadRecord({
      entityCui: '12345678',
      phase: 'awaiting_reply',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const baseRepo = makeInMemoryCorrespondenceRepo({
      threads: [existingThread],
    });
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const findPlatformSendThreadByEntity = vi
      .fn()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(existingThread));
    const createThread = vi.fn(async () =>
      err(createConflictError('A correspondence thread already exists for this key.'))
    );
    const repo = {
      ...baseRepo,
      findPlatformSendThreadByEntity,
      createThread,
    };

    const result = await requestPublicDebatePlatformSend(
      {
        repo,
        emailSender: {
          getFromAddress() {
            return 'noreply@transparenta.eu';
          },
          send,
        },
        templateRenderer: makePublicDebateTemplateRenderer(),
        auditCcRecipients: [],
        platformBaseUrl: 'https://transparenta.test',
        captureAddress: 'debate@transparenta.test',
      },
      {
        ownerUserId: 'user-1',
        entityCui: '12345678',
        institutionEmail: 'contact@primarie.ro',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.created).toBe(false);
      expect(result.value.thread.id).toBe(existingThread.id);
    }
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
