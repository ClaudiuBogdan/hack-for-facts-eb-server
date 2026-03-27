import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  DEBATE_REQUEST_INTERACTION_ID,
  makePublicDebateRequestSyncHook,
} from '@/app/public-debate-request-dispatcher.js';
import { PUBLIC_DEBATE_REQUEST_TYPE } from '@/modules/institution-correspondence/index.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
} from '../../fixtures/fakes.js';
import {
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../institution-correspondence/fake-repo.js';

import type { Logger } from 'pino';

function createDebateRequestRecord(input: {
  entityCui?: string;
  submissionPath: 'send_yourself' | 'request_platform';
  organizationName?: string | null;
  updatedAt?: string;
  submittedAt?: string | null;
  key?: string;
}) {
  const entityCui = input.entityCui ?? '12345678';
  const updatedAt = input.updatedAt ?? '2026-03-26T10:00:00.000Z';
  const submittedAt = input.submittedAt ?? '2026-03-26T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: input.key ?? `${DEBATE_REQUEST_INTERACTION_ID}::entity:${entityCui}`,
    interactionId: DEBATE_REQUEST_INTERACTION_ID,
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          primariaEmail: 'contact@primarie.ro',
          isNgo: input.organizationName !== null,
          organizationName: input.organizationName ?? 'Asociatia Test',
          ngoSenderEmail: null,
          threadKey: null,
          submissionPath: input.submissionPath,
          submittedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt,
  });
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createDispatcher(
  options: {
    sendFails?: boolean;
    repo?: ReturnType<typeof makeInMemoryCorrespondenceRepo>;
    logger?: ReturnType<typeof createLogger>;
  } = {}
) {
  const sentEmails: Record<string, unknown>[] = [];
  const repo = options.repo ?? makeInMemoryCorrespondenceRepo();
  const logger = options.logger ?? createLogger();

  const hook = makePublicDebateRequestSyncHook({
    repo,
    emailSender: {
      getFromAddress() {
        return 'noreply@transparenta.eu';
      },
      async send(params) {
        sentEmails.push(params as unknown as Record<string, unknown>);
        if (options.sendFails === true) {
          return err({
            type: 'SERVER' as const,
            message: 'Resend failed',
            retryable: true,
          });
        }

        return ok({ emailId: `email-${String(sentEmails.length)}` });
      },
    },
    templateRenderer: {
      renderPublicDebateRequest(input) {
        return {
          subject: `Public debate [teu:${input.threadKey}]`,
          text: `Text for ${input.institutionEmail}`,
          html: `<p>${input.institutionEmail}</p>`,
        };
      },
    },
    auditCcRecipients: ['audit@transparenta.test'],
    platformBaseUrl: 'https://transparenta.test',
    captureAddress: 'debate@transparenta.test',
    logger: logger as unknown as Logger,
  });

  return {
    hook,
    repo,
    sentEmails,
    logger,
  };
}

describe('makePublicDebateRequestSyncHook', () => {
  it('dispatches a platform send for a valid pending debate-request submission', async () => {
    const { hook, repo, sentEmails } = createDispatcher();

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createDebateRequestRecord({
              submissionPath: 'request_platform',
            }),
          },
        }),
      ],
    });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.['to']).toBe('contact@primarie.ro');

    const threadResult = await repo.findPlatformSendThreadByEntity({
      entityCui: '12345678',
      campaign: PUBLIC_DEBATE_REQUEST_TYPE,
    });
    expect(threadResult.isOk()).toBe(true);
    if (threadResult.isOk()) {
      expect(threadResult.value?.phase).toBe('awaiting_reply');
      expect(threadResult.value?.record.correspondence).toHaveLength(1);
      expect(threadResult.value?.record.submissionPath).toBe('platform_send');
    }
  });

  it('skips send_yourself submissions', async () => {
    const { hook, repo, sentEmails } = createDispatcher();

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createDebateRequestRecord({
              submissionPath: 'send_yourself',
            }),
          },
        }),
      ],
    });

    expect(sentEmails).toHaveLength(0);
    expect(repo.snapshotThreads()).toHaveLength(0);
  });

  it('skips when a non-failed platform-send thread already exists for the entity', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          entityCui: '12345678',
          phase: 'awaiting_reply',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
          }),
        }),
      ],
    });
    const { hook, sentEmails } = createDispatcher({ repo });

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createDebateRequestRecord({
              submissionPath: 'request_platform',
            }),
          },
        }),
      ],
    });

    expect(sentEmails).toHaveLength(0);
    expect(repo.snapshotThreads()).toHaveLength(1);
  });

  it('treats failed platform-send threads as existing and skips another send', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          entityCui: '12345678',
          phase: 'failed',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
          }),
        }),
      ],
    });
    const { hook, sentEmails } = createDispatcher({ repo });

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createDebateRequestRecord({
              submissionPath: 'request_platform',
            }),
          },
        }),
      ],
    });

    expect(sentEmails).toHaveLength(0);
    expect(repo.snapshotThreads()).toHaveLength(1);
  });

  it('does not let self-send threads block a new platform send', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          entityCui: '12345678',
          record: createThreadAggregateRecord({
            submissionPath: 'self_send_cc',
          }),
        }),
      ],
    });
    const { hook, sentEmails } = createDispatcher({ repo });

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createDebateRequestRecord({
              submissionPath: 'request_platform',
            }),
          },
        }),
      ],
    });

    expect(sentEmails).toHaveLength(1);
    expect(repo.snapshotThreads()).toHaveLength(2);
  });

  it('uses the newest record.updatedAt when multiple events share the same key', async () => {
    const { hook, repo, sentEmails } = createDispatcher();
    const key = `${DEBATE_REQUEST_INTERACTION_ID}::entity:12345678`;

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          eventId: 'event-newest',
          payload: {
            record: createDebateRequestRecord({
              key,
              submissionPath: 'request_platform',
              updatedAt: '2026-03-26T10:01:00.000Z',
            }),
          },
        }),
        createTestInteractiveUpdatedEvent({
          eventId: 'event-stale',
          payload: {
            record: createDebateRequestRecord({
              key,
              submissionPath: 'send_yourself',
              updatedAt: '2026-03-26T10:00:00.000Z',
            }),
          },
        }),
      ],
    });

    expect(sentEmails).toHaveLength(1);

    const threadResult = await repo.findPlatformSendThreadByEntity({
      entityCui: '12345678',
      campaign: PUBLIC_DEBATE_REQUEST_TYPE,
    });
    expect(threadResult.isOk()).toBe(true);
    if (threadResult.isOk()) {
      expect(threadResult.value?.phase).toBe('awaiting_reply');
    }
  });

  it('ignores unrelated interaction ids, non-entity scope, and invalid payloads', async () => {
    const { hook, repo, sentEmails } = createDispatcher();

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createTestInteractiveRecord({
              interactionId: 'campaign:other',
              scope: { type: 'entity', entityCui: '12345678' },
              phase: 'pending',
              value: {
                kind: 'json',
                json: { value: { submissionPath: 'request_platform' } },
              },
            }),
          },
        }),
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createTestInteractiveRecord({
              interactionId: DEBATE_REQUEST_INTERACTION_ID,
              scope: { type: 'global' },
              phase: 'pending',
              value: {
                kind: 'json',
                json: {
                  value: {
                    primariaEmail: 'contact@primarie.ro',
                    isNgo: true,
                    organizationName: 'Asociatia Test',
                    submissionPath: 'request_platform',
                    submittedAt: '2026-03-26T10:00:00.000Z',
                  },
                },
              },
            }),
          },
        }),
        createTestInteractiveUpdatedEvent({
          payload: {
            record: createTestInteractiveRecord({
              interactionId: DEBATE_REQUEST_INTERACTION_ID,
              scope: { type: 'entity', entityCui: '12345678' },
              phase: 'pending',
              value: {
                kind: 'json',
                json: { value: { primariaEmail: 'contact@primarie.ro' } },
              },
            }),
          },
        }),
      ],
    });

    expect(sentEmails).toHaveLength(0);
    expect(repo.snapshotThreads()).toHaveLength(0);
  });

  it('logs and swallows send failures while keeping the failed thread', async () => {
    const logger = createLogger();
    const { hook, repo, sentEmails } = createDispatcher({
      logger,
      sendFails: true,
    });

    await expect(
      hook({
        userId: 'user-1',
        events: [
          createTestInteractiveUpdatedEvent({
            payload: {
              record: createDebateRequestRecord({
                submissionPath: 'request_platform',
              }),
            },
          }),
        ],
      })
    ).resolves.toBeUndefined();

    expect(sentEmails).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const threads = repo.snapshotThreads();
    const failedThread = threads.find(
      (t) => t.entityCui === '12345678' && t.record.campaign === PUBLIC_DEBATE_REQUEST_TYPE
    );
    expect(failedThread).toBeDefined();
    expect(failedThread?.phase).toBe('failed');
    expect(failedThread?.record.correspondence).toHaveLength(0);
  });
});
