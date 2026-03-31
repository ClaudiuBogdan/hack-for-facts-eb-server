import { UnrecoverableError } from 'bullmq';
import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makePublicDebateRequestUserEventHandler } from '@/modules/user-events/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../../fixtures/fakes.js';
import {
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../institution-correspondence/fake-repo.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

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

function createDebateRequestRecord(input: {
  entityCui?: string;
  submissionPath: 'send_yourself' | 'request_platform';
  updatedAt?: string;
  key?: string;
}) {
  const entityCui = input.entityCui ?? '12345678';
  const updatedAt = input.updatedAt ?? '2026-03-31T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: input.key ?? `campaign:debate-request::entity:${entityCui}`,
    interactionId: 'campaign:debate-request',
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
          isNgo: true,
          organizationName: 'Asociatia Test',
          ngoSenderEmail: null,
          threadKey: null,
          submissionPath: input.submissionPath,
          submittedAt: updatedAt,
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

describe('makePublicDebateRequestUserEventHandler', () => {
  it('matches only interactive.updated user events', () => {
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo: makeFakeLearningProgressRepo(),
      repo: makeInMemoryCorrespondenceRepo(),
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send() {
          return ok({ emailId: 'email-1' });
        },
      },
      templateRenderer: {
        renderPublicDebateRequest() {
          return {
            subject: 'subject',
            text: 'text',
            html: '<p>html</p>',
          };
        },
      },
      auditCcRecipients: [],
      platformBaseUrl: 'https://transparenta.test',
      captureAddress: 'debate@transparenta.test',
      logger: pinoLogger({ level: 'silent' }),
    });

    expect(
      handler.matches({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'interactive.updated',
        occurredAt: '2026-03-31T10:00:00.000Z',
        recordKey: 'campaign:debate-request::entity:12345678',
      })
    ).toBe(true);
    expect(
      handler.matches({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'progress.reset',
        occurredAt: '2026-03-31T10:00:00.000Z',
      })
    ).toBe(false);
  });

  it('sends only for eligible current records', async () => {
    const sentEmails: Record<string, unknown>[] = [];
    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo,
      repo: correspondenceRepo,
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send(params) {
          sentEmails.push(params as unknown as Record<string, unknown>);
          return ok({ emailId: 'email-1' });
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

    expect(sentEmails).toHaveLength(1);
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(1);
  });

  it('skips safely when the record is missing', async () => {
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo: makeFakeLearningProgressRepo(),
      repo: correspondenceRepo,
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send() {
          return ok({ emailId: 'email-1' });
        },
      },
      templateRenderer: {
        renderPublicDebateRequest() {
          return {
            subject: 'subject',
            text: 'text',
            html: '<p>html</p>',
          };
        },
      },
      auditCcRecipients: [],
      platformBaseUrl: 'https://transparenta.test',
      captureAddress: 'debate@transparenta.test',
      logger: pinoLogger({ level: 'silent' }),
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: '2026-03-31T10:00:00.000Z',
      recordKey: 'campaign:debate-request::entity:12345678',
    });

    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
  });

  it('throws when loading the learning progress record fails', async () => {
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo: makeFakeLearningProgressRepo({
        simulateDbError: true,
      }),
      repo: makeInMemoryCorrespondenceRepo(),
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send() {
          return ok({ emailId: 'email-1' });
        },
      },
      templateRenderer: {
        renderPublicDebateRequest() {
          return {
            subject: 'subject',
            text: 'text',
            html: '<p>html</p>',
          };
        },
      },
      auditCcRecipients: [],
      platformBaseUrl: 'https://transparenta.test',
      captureAddress: 'debate@transparenta.test',
      logger: pinoLogger({ level: 'silent' }),
    });

    await expect(
      handler.handle({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'interactive.updated',
        occurredAt: '2026-03-31T10:00:00.000Z',
        recordKey: 'campaign:debate-request::entity:12345678',
      })
    ).rejects.toThrow('Simulated database error');
  });

  it('skips records whose current state is not request_platform', async () => {
    const record = createDebateRequestRecord({
      submissionPath: 'send_yourself',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo,
      repo: correspondenceRepo,
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send() {
          return ok({ emailId: 'email-1' });
        },
      },
      templateRenderer: {
        renderPublicDebateRequest() {
          return {
            subject: 'subject',
            text: 'text',
            html: '<p>html</p>',
          };
        },
      },
      auditCcRecipients: [],
      platformBaseUrl: 'https://transparenta.test',
      captureAddress: 'debate@transparenta.test',
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

    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
  });

  it('skips when a platform-send thread already exists', async () => {
    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          entityCui: '12345678',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
          }),
        }),
      ],
    });
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo,
      repo: correspondenceRepo,
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send() {
          return ok({ emailId: 'email-1' });
        },
      },
      templateRenderer: {
        renderPublicDebateRequest() {
          return {
            subject: 'subject',
            text: 'text',
            html: '<p>html</p>',
          };
        },
      },
      auditCcRecipients: [],
      platformBaseUrl: 'https://transparenta.test',
      captureAddress: 'debate@transparenta.test',
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

    expect(correspondenceRepo.snapshotThreads()).toHaveLength(1);
  });

  it('throws when the downstream send fails with a retryable error so the queue can retry', async () => {
    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo,
      repo: correspondenceRepo,
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send() {
          return err({
            type: 'SERVER' as const,
            message: 'Provider send failed',
            retryable: true,
          });
        },
      },
      templateRenderer: {
        renderPublicDebateRequest() {
          return {
            subject: 'subject',
            text: 'text',
            html: '<p>html</p>',
          };
        },
      },
      auditCcRecipients: [],
      platformBaseUrl: 'https://transparenta.test',
      captureAddress: 'debate@transparenta.test',
      logger: pinoLogger({ level: 'silent' }),
    });

    await expect(
      handler.handle({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'interactive.updated',
        occurredAt: record.updatedAt,
        recordKey: record.key,
      })
    ).rejects.toThrow('Provider send failed');
  });

  it('throws UnrecoverableError for non-retryable correspondence failures', async () => {
    const baseRecord = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const record = {
      ...baseRecord,
      value: {
        kind: 'json' as const,
        json: {
          value: {
            primariaEmail: 'not-an-email',
            isNgo: true,
            organizationName: 'Asociatia Test',
            ngoSenderEmail: null,
            threadKey: null,
            submissionPath: 'request_platform',
            submittedAt: baseRecord.updatedAt,
          },
        },
      },
    };
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const handler = makePublicDebateRequestUserEventHandler({
      learningProgressRepo,
      repo: makeInMemoryCorrespondenceRepo(),
      emailSender: {
        getFromAddress() {
          return 'noreply@transparenta.eu';
        },
        async send() {
          return ok({ emailId: 'email-1' });
        },
      },
      templateRenderer: {
        renderPublicDebateRequest() {
          return {
            subject: 'subject',
            text: 'text',
            html: '<p>html</p>',
          };
        },
      },
      auditCcRecipients: [],
      platformBaseUrl: 'https://transparenta.test',
      captureAddress: 'debate@transparenta.test',
      logger: pinoLogger({ level: 'silent' }),
    });

    await expect(
      handler.handle({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'interactive.updated',
        occurredAt: '2026-03-31T10:00:00.000Z',
        recordKey: record.key,
      })
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
