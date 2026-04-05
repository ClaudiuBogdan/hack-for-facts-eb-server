import { describe, expect, it } from 'vitest';

import {
  readPlatformSendThreadMetadata,
  writePlatformSendThreadMetadata,
} from '@/modules/institution-correspondence/index.js';

import { createThreadAggregateRecord } from './fake-repo.js';

describe('platform-send-thread-metadata', () => {
  it('reads normalized platform-send metadata without touching unrelated metadata', () => {
    const record = createThreadAggregateRecord({
      metadata: {
        providerSendAttemptId: 'attempt-1',
        providerSendEmailId: 'email-1',
        providerSendObservedAt: 42,
        providerSendMessageId: '<message-1>',
        threadStartedPublishedAt: null,
        unrelated: 'keep-me',
      },
    });

    expect(readPlatformSendThreadMetadata(record)).toEqual({
      providerSendAttemptId: 'attempt-1',
      providerSendEmailId: 'email-1',
      providerSendObservedAt: null,
      providerSendMessageId: '<message-1>',
      threadStartedPublishedAt: null,
    });
    expect(record.metadata).toEqual({
      providerSendAttemptId: 'attempt-1',
      providerSendEmailId: 'email-1',
      providerSendObservedAt: 42,
      providerSendMessageId: '<message-1>',
      threadStartedPublishedAt: null,
      unrelated: 'keep-me',
    });
  });

  it('writes normalized metadata while preserving unrelated metadata keys', () => {
    const record = createThreadAggregateRecord({
      metadata: {
        providerSendAttemptId: 'attempt-1',
        unrelated: 'keep-me',
      },
    });

    expect(
      writePlatformSendThreadMetadata(record, {
        providerSendEmailId: 'email-1',
        providerSendObservedAt: '2026-04-03T16:43:04.930Z',
        providerSendMessageId: null,
      })
    ).toEqual({
      providerSendAttemptId: 'attempt-1',
      providerSendEmailId: 'email-1',
      providerSendObservedAt: '2026-04-03T16:43:04.930Z',
      unrelated: 'keep-me',
    });
  });

  it('removes known keys when the patch clears them', () => {
    const record = createThreadAggregateRecord({
      metadata: {
        providerSendAttemptId: 'attempt-1',
        providerSendEmailId: 'email-1',
        providerSendObservedAt: '2026-04-03T16:43:04.930Z',
        providerSendMessageId: '<message-1>',
        threadStartedPublishedAt: '2026-04-03T16:43:04.930Z',
        unrelated: 'keep-me',
      },
    });

    expect(
      writePlatformSendThreadMetadata(record, {
        providerSendAttemptId: null,
        providerSendEmailId: null,
        providerSendObservedAt: null,
        providerSendMessageId: null,
        threadStartedPublishedAt: null,
      })
    ).toEqual({
      unrelated: 'keep-me',
    });
  });
});
