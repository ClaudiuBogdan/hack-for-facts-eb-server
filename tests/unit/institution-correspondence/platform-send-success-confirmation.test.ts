import { describe, expect, it } from 'vitest';

import {
  buildReconcilePlatformSendSuccessInputFromThread,
  markPlatformSendSuccessConfirmed,
  readPlatformSendSuccessMetadata,
  withPlatformSendSuccessMetadata,
} from '@/modules/institution-correspondence/index.js';

import {
  createAwaitingReplyPlatformSendThreadPendingConfirmation,
  createPlatformSendSuccessInput,
  createThreadAggregateRecord,
  createThreadRecord,
} from './fake-repo.js';

describe('platform-send-success-confirmation helpers', () => {
  it('round-trips provider metadata and the publish marker', () => {
    const successInput = createPlatformSendSuccessInput();
    const record = createThreadAggregateRecord({
      submissionPath: 'platform_send',
      metadata: {},
    });

    const withProviderMetadata = withPlatformSendSuccessMetadata(record, successInput);
    const withMarker = markPlatformSendSuccessConfirmed(
      {
        ...record,
        metadata: withProviderMetadata,
      },
      successInput.observedAt
    );

    expect(
      readPlatformSendSuccessMetadata({
        ...record,
        metadata: withProviderMetadata,
      })
    ).toEqual({
      providerSendAttemptId: null,
      providerSendEmailId: 'email-1',
      providerSendObservedAt: '2026-04-03T16:43:04.930Z',
      providerSendMessageId: '<message-1>',
      threadStartedPublishedAt: null,
    });

    expect(
      readPlatformSendSuccessMetadata({
        ...record,
        metadata: withMarker,
      })
    ).toEqual({
      providerSendAttemptId: null,
      providerSendEmailId: 'email-1',
      providerSendObservedAt: '2026-04-03T16:43:04.930Z',
      providerSendMessageId: '<message-1>',
      threadStartedPublishedAt: '2026-04-03T16:43:04.930Z',
    });
  });

  it('returns null when rebuilding reconcile input from incomplete thread state', () => {
    const thread = createThreadRecord({
      id: 'thread-incomplete',
      threadKey: 'thread-incomplete',
      phase: 'awaiting_reply',
      record: createThreadAggregateRecord({
        submissionPath: 'platform_send',
        correspondence: [],
        metadata: {},
      }),
    });

    expect(buildReconcilePlatformSendSuccessInputFromThread(thread)).toBeNull();
  });

  it('rebuilds reconcile input from a platform-send outbound thread', () => {
    const successInput = createPlatformSendSuccessInput({
      threadKey: 'thread-success',
      resendEmailId: 'email-success',
      messageId: '<message-success>',
      subject: 'Cerere dezbatere buget local - Comuna Helper',
    });
    const thread = createAwaitingReplyPlatformSendThreadPendingConfirmation({
      successInput,
      thread: {
        id: 'thread-success',
      },
    });

    expect(buildReconcilePlatformSendSuccessInputFromThread(thread)).toEqual(successInput);
  });
});
