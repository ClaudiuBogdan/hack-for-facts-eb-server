import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSelfSendInteractionKey,
  createConflictError,
  makeInstitutionCorrespondenceResendSideEffect,
  readPlatformSendSuccessMetadata,
  type PublicDebateSelfSendContext,
  type PublicDebateSelfSendContextMatch,
} from '@/modules/institution-correspondence/index.js';

import {
  createCorrespondenceEntry,
  createPlatformSendOutboundEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  createSendingPlatformSendThread,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

import type { StoredResendEmailEvent } from '@/modules/resend-webhooks/index.js';

const testLogger = pinoLogger({ level: 'silent' });
const captureAddress = 'debate@transparenta.test';
const subject = 'Cerere organizare dezbatere publica - Oras Test - buget local 2026';
const interactionKey = buildSelfSendInteractionKey('ngo@example.com', subject);

const createSelfSendContext = (
  overrides: Partial<PublicDebateSelfSendContext> = {}
): PublicDebateSelfSendContext => ({
  userId: overrides.userId ?? 'user-1',
  recordKey: overrides.recordKey ?? 'funky:interaction:public_debate_request::entity:12345678',
  entityCui: overrides.entityCui ?? '12345678',
  institutionEmail: overrides.institutionEmail ?? 'contact@primarie.ro',
  requesterOrganizationName: overrides.requesterOrganizationName ?? 'Asociatia Test',
  ngoSenderEmail: overrides.ngoSenderEmail ?? 'ngo@example.com',
  preparedSubject: overrides.preparedSubject ?? subject,
  submittedAt: overrides.submittedAt ?? '2026-03-25T12:00:00.000Z',
});

const createSelfSendMatch = (
  overrides: Partial<PublicDebateSelfSendContextMatch> = {}
): PublicDebateSelfSendContextMatch => ({
  context: overrides.context ?? createSelfSendContext(),
  interactionKey: overrides.interactionKey ?? interactionKey,
  matchCount: overrides.matchCount ?? 1,
});

const createStoredEvent = (
  overrides: Partial<StoredResendEmailEvent> = {}
): StoredResendEmailEvent => ({
  id: 'stored-1',
  svixId: 'svix-1',
  eventType: 'email.received',
  webhookReceivedAt: new Date('2026-03-25T12:00:01.000Z'),
  eventCreatedAt: new Date('2026-03-25T12:00:01.000Z'),
  emailId: 'received-email-1',
  fromAddress: 'ngo@example.com',
  toAddresses: ['contact@primarie.ro'],
  ccAddresses: [captureAddress],
  bccAddresses: [],
  messageId: null,
  subject,
  emailCreatedAt: new Date('2026-03-25T12:00:00.000Z'),
  broadcastId: null,
  templateId: null,
  tags: null,
  attachmentsJson: null,
  bounceType: null,
  bounceSubType: null,
  bounceMessage: null,
  bounceDiagnosticCode: null,
  clickIpAddress: null,
  clickLink: null,
  clickTimestamp: null,
  clickUserAgent: null,
  threadKey: null,
  metadata: {},
  ...overrides,
});

describe('makeInstitutionCorrespondenceResendSideEffect', () => {
  it('reconciles email.sent into awaiting_reply for platform-send threads and publishes thread_started once', async () => {
    const emailCreatedAt = new Date('2026-04-03T16:43:05.312Z');
    const eventCreatedAt = new Date('2026-04-03T16:49:05.312Z');
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createSendingPlatformSendThread({
          id: 'thread-platform-1',
          threadKey: 'thread-key-platform-1',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
            correspondence: [],
            metadata: {},
          }),
        }),
      ],
    });
    const publish = vi.fn(async () =>
      ok({
        status: 'queued' as const,
        notificationIds: ['notif-1'],
        createdOutboxIds: ['outbox-1'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['outbox-1'],
        enqueueFailedOutboxIds: [],
      })
    );

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(null);
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        async updateStoredEvent() {
          throw new Error('not used');
        },
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          throw new Error('not used');
        },
      },
      captureAddress,
      auditCcRecipients: [],
      updatePublisher: {
        publish,
      },
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.sent',
        created_at: eventCreatedAt.toISOString(),
        data: {
          email_id: 'email-platform-1',
          from: 'funky@dev.transparenta.eu',
          to: ['contact@primarie.ro'],
          subject: 'Cerere dezbatere buget local - Comuna Test',
          created_at: emailCreatedAt.toISOString(),
          message_id: '<message-platform-1>',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-platform-1',
        eventType: 'email.sent',
        emailId: 'email-platform-1',
        fromAddress: 'funky@dev.transparenta.eu',
        toAddresses: ['contact@primarie.ro'],
        subject: 'Cerere dezbatere buget local - Comuna Test',
        threadKey: 'thread-key-platform-1',
        eventCreatedAt,
        emailCreatedAt,
      }),
    });

    const thread = await repo.findThreadById('thread-platform-1');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('awaiting_reply');
      expect(thread.value?.record.correspondence).toHaveLength(1);
      expect(thread.value?.record.correspondence[0]?.resendEmailId).toBe('email-platform-1');
      expect(thread.value?.record.correspondence[0]?.messageId).toBe('<message-platform-1>');
      expect(thread.value?.record.correspondence[0]?.occurredAt).toBe('2026-04-03T16:43:05.312Z');
      expect(thread.value?.lastEmailAt?.toISOString()).toBe('2026-04-03T16:43:05.312Z');
      expect(readPlatformSendSuccessMetadata(thread.value!.record).providerSendEmailId).toBe(
        'email-platform-1'
      );
      expect(readPlatformSendSuccessMetadata(thread.value!.record).providerSendObservedAt).toBe(
        '2026-04-03T16:43:05.312Z'
      );
      expect(readPlatformSendSuccessMetadata(thread.value!.record).threadStartedPublishedAt).toBe(
        '2026-04-03T16:43:05.312Z'
      );
    }

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'thread_started',
        occurredAt: emailCreatedAt,
      })
    );
  });

  it('creates a self-send thread from the interaction key and official email lookup', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const approvePendingRecord = vi.fn(async () => ok(undefined));
    const updateStoredEvent = vi.fn().mockResolvedValue(
      ok(
        createStoredEvent({
          threadKey: 'thread-created',
          messageId: '<message-1>',
          metadata: { matchStatus: 'matched' },
        })
      )
    );

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails(emails) {
          return ok(
            emails.includes('contact@primarie.ro')
              ? [{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]
              : []
          );
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(createSelfSendMatch());
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-1',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject,
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-1>' },
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<message-1>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      selfSendApprovalService: {
        approvePendingRecord,
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-1',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent(),
    });

    const createdThread = await repo.findSelfSendThreadByInteractionKey(interactionKey);
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.record.submissionPath).toBe('self_send_cc');
      expect(createdThread.value?.phase).toBe('awaiting_reply');
      expect(createdThread.value?.threadKey).not.toContain('[teu:');
      expect(createdThread.value?.record.metadata).toEqual({
        interactionKey,
        sourceInteractionRecordKey: 'funky:interaction:public_debate_request::entity:12345678',
        preparedSubject: subject,
        expectedNgoSenderEmail: 'ngo@example.com',
        capturedFromAddress: 'ngo@example.com',
        senderEmailVerified: true,
      });
      expect(createdThread.value?.record.correspondence).toHaveLength(1);
      expect(createdThread.value?.record.correspondence[0]?.direction).toBe('outbound');
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-1', {
      threadKey: expect.any(String),
      messageId: '<message-1>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'created_from_interaction_key_and_official_email',
        matchedBy: 'interaction_key',
      },
    });
    expect(approvePendingRecord).toHaveBeenCalledWith({
      userId: 'user-1',
      recordKey: 'funky:interaction:public_debate_request::entity:12345678',
    });
  });

  it('reuses the captured legacy subject token as the created self-send thread key', async () => {
    const legacySubject =
      'Cerere organizare dezbatere publica - Oras Test - buget local 2026 [teu:legacy-self-send-key]';
    const legacyInteractionKey = buildSelfSendInteractionKey('ngo@example.com', legacySubject);
    const repo = makeInMemoryCorrespondenceRepo();
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(
            createSelfSendMatch({
              interactionKey: legacyInteractionKey,
              context: createSelfSendContext({
                preparedSubject: legacySubject,
              }),
            })
          );
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-legacy',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject: legacySubject,
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-legacy>' },
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<message-legacy>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-legacy',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject: legacySubject,
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-legacy',
        svixId: 'svix-legacy',
        emailId: 'received-email-legacy',
        subject: legacySubject,
      }),
    });

    const createdThread = await repo.findSelfSendThreadByInteractionKey(legacyInteractionKey);
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.threadKey).toBe('legacy-self-send-key');
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-legacy', {
      threadKey: 'legacy-self-send-key',
      messageId: '<message-legacy>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'created_from_interaction_key_and_official_email',
        matchedBy: 'interaction_key',
      },
    });
  });

  it('records duplicate interaction resolution and uses first_wins when multiple interactions match', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(createSelfSendMatch({ matchCount: 2 }));
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-dup',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject,
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-dup>' },
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<message-dup>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-dup',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-dup',
        svixId: 'svix-dup',
        emailId: 'received-email-dup',
      }),
    });

    const createdThread = await repo.findSelfSendThreadByInteractionKey(interactionKey);
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.record.metadata).toEqual({
        interactionKey,
        sourceInteractionRecordKey: 'funky:interaction:public_debate_request::entity:12345678',
        preparedSubject: subject,
        expectedNgoSenderEmail: 'ngo@example.com',
        capturedFromAddress: 'ngo@example.com',
        senderEmailVerified: true,
        duplicateInteractionCount: 2,
        duplicateResolution: 'first_wins',
      });
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-dup', {
      threadKey: expect.any(String),
      messageId: '<message-dup>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'created_from_interaction_key_and_official_email',
        matchedBy: 'interaction_key',
        duplicateInteractionCount: 2,
        duplicateResolution: 'first_wins',
      },
    });
  });

  it('reuses an existing self-send thread when another captured email shares the same interaction key', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          threadKey: 'thread-key-1',
          phase: 'awaiting_reply',
          record: createThreadAggregateRecord({
            submissionPath: 'self_send_cc',
            correspondence: [
              createCorrespondenceEntry({
                id: 'entry-1',
                direction: 'outbound',
                source: 'self_send_cc',
                resendEmailId: 'captured-email-1',
                messageId: '<message-existing>',
                subject,
              }),
            ],
            metadata: {
              interactionKey,
              sourceInteractionRecordKey:
                'funky:interaction:public_debate_request::entity:12345678',
            },
          }),
        }),
      ],
    });
    const approvePendingRecord = vi.fn(async () => ok(undefined));
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(createSelfSendMatch());
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'captured-email-2',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:30:00.000Z'),
            subject,
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-2>' },
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<message-2>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      selfSendApprovalService: {
        approvePendingRecord,
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:30:01.000Z',
        data: {
          email_id: 'captured-email-2',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T12:30:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-existing',
        svixId: 'svix-existing',
        emailId: 'captured-email-2',
      }),
    });

    const thread = await repo.findThreadById('thread-1');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('awaiting_reply');
      expect(thread.value?.record.correspondence).toHaveLength(2);
      expect(thread.value?.record.correspondence[1]?.source).toBe('self_send_cc');
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-existing', {
      threadKey: 'thread-key-1',
      messageId: '<message-2>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'matched_existing_self_send_thread_by_interaction_key',
        matchedBy: 'interaction_key',
      },
    });
    expect(approvePendingRecord).toHaveBeenCalledWith({
      userId: 'user-1',
      recordKey: 'funky:interaction:public_debate_request::entity:12345678',
    });
  });

  it('does not reuse a self-send thread from a different entity that shares the interaction key', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-wrong-entity',
          entityCui: '87654321',
          threadKey: 'thread-key-wrong-entity',
          phase: 'awaiting_reply',
          record: createThreadAggregateRecord({
            submissionPath: 'self_send_cc',
            correspondence: [
              createCorrespondenceEntry({
                id: 'entry-wrong-entity',
                direction: 'outbound',
                source: 'self_send_cc',
                resendEmailId: 'captured-email-wrong-entity',
                messageId: '<message-wrong-entity>',
                subject,
              }),
            ],
            metadata: {
              interactionKey,
              sourceInteractionRecordKey:
                'funky:interaction:public_debate_request::entity:87654321',
            },
          }),
        }),
      ],
    });
    const approvePendingRecord = vi.fn(async () => ok(undefined));
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(createSelfSendMatch());
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'captured-email-correct-entity',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:35:00.000Z'),
            subject,
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-correct-entity>' },
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<message-correct-entity>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      selfSendApprovalService: {
        approvePendingRecord,
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:35:01.000Z',
        data: {
          email_id: 'captured-email-correct-entity',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T12:35:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-correct-entity',
        svixId: 'svix-correct-entity',
        emailId: 'captured-email-correct-entity',
      }),
    });

    const wrongThread = await repo.findThreadById('thread-wrong-entity');
    expect(wrongThread.isOk()).toBe(true);
    if (wrongThread.isOk()) {
      expect(wrongThread.value?.record.correspondence).toHaveLength(1);
    }

    const threads = repo.snapshotThreads();
    expect(threads).toHaveLength(2);
    expect(
      threads.some(
        (thread) =>
          thread.id !== 'thread-wrong-entity' &&
          thread.entityCui === '12345678' &&
          thread.record.submissionPath === 'self_send_cc'
      )
    ).toBe(true);

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-correct-entity', {
      threadKey: expect.any(String),
      messageId: '<message-correct-entity>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'created_from_interaction_key_and_official_email',
        matchedBy: 'interaction_key',
      },
    });
    expect(approvePendingRecord).toHaveBeenCalledWith({
      userId: 'user-1',
      recordKey: 'funky:interaction:public_debate_request::entity:12345678',
    });
  });

  it('reuses a concurrently created self-send thread when createThread conflicts', async () => {
    const existingThread = createThreadRecord({
      id: 'thread-concurrent',
      threadKey: 'thread-key-concurrent',
      phase: 'awaiting_reply',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'self_send_cc',
        metadata: {
          interactionKey,
          sourceInteractionRecordKey: 'funky:interaction:public_debate_request::entity:12345678',
        },
      }),
    });
    const backingRepo = makeInMemoryCorrespondenceRepo({
      threads: [existingThread],
    });
    const approvePendingRecord = vi.fn(async () => ok(undefined));
    const findSelfSendThreadByInteractionKey = vi
      .fn()
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(existingThread));
    const createThread = vi.fn(async () =>
      err(createConflictError('A correspondence thread already exists for this key.'))
    );
    const repo = {
      ...backingRepo,
      findSelfSendThreadByInteractionKey,
      createThread,
    };
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(createSelfSendMatch());
        },
      },
      selfSendApprovalService: {
        approvePendingRecord,
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-race',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:45:00.000Z'),
            subject,
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-race>' },
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<message-race>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:45:01.000Z',
        data: {
          email_id: 'received-email-race',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T12:45:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-race',
        svixId: 'svix-race',
        emailId: 'received-email-race',
      }),
    });

    const thread = await backingRepo.findThreadById('thread-concurrent');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.record.correspondence).toHaveLength(1);
      expect(thread.value?.record.correspondence[0]?.resendEmailId).toBe('received-email-race');
    }
    expect(updateStoredEvent).toHaveBeenCalledWith('stored-race', {
      threadKey: 'thread-key-concurrent',
      messageId: '<message-race>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'matched_existing_self_send_thread_by_interaction_key',
        matchedBy: 'interaction_key',
      },
    });
    expect(approvePendingRecord).toHaveBeenCalledWith({
      userId: 'user-1',
      recordKey: 'funky:interaction:public_debate_request::entity:12345678',
    });
  });

  it('matches a reply by headers and moves the thread to review', async () => {
    const existingThread = createThreadRecord({
      id: 'thread-1',
      threadKey: 'thread-key-1',
      phase: 'awaiting_reply',
      record: createThreadAggregateRecord({
        correspondence: [
          createCorrespondenceEntry({
            id: 'entry-1',
            direction: 'outbound',
            source: 'platform_send',
            resendEmailId: 'outbound-email-1',
            messageId: '<message-1>',
          }),
        ],
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({ threads: [existingThread] });
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(null);
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok('thread-key-1');
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-2',
            to: [captureAddress],
            from: 'office@primarie.ro',
            createdAt: new Date('2026-03-25T13:00:00.000Z'),
            subject: 'Re: Subject',
            html: '<p>Raspuns</p>',
            text: 'Raspuns',
            headers: { 'in-reply-to': '<message-1>', 'message-id': '<message-2>' },
            bcc: [],
            cc: [],
            replyTo: [],
            messageId: '<message-2>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T13:00:01.000Z',
        data: {
          email_id: 'received-email-2',
          from: 'office@primarie.ro',
          to: [captureAddress],
          cc: [],
          bcc: [],
          subject: 'Re: Subject',
          created_at: '2026-03-25T13:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-2',
        svixId: 'svix-2',
        emailId: 'received-email-2',
        fromAddress: 'office@primarie.ro',
        toAddresses: [captureAddress],
        subject: 'Re: Subject',
      }),
    });

    const thread = await repo.findThreadById('thread-1');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('reply_received_unreviewed');
      expect(thread.value?.record.correspondence).toHaveLength(2);
      expect(thread.value?.record.correspondence[1]?.direction).toBe('inbound');
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-2', {
      threadKey: 'thread-key-1',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'matched_by_headers',
        matchedBy: 'headers',
      },
    });
  });

  it('persists the captured self-send message id so header-only follow-up replies can match', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const storedEvents = new Map<string, StoredResendEmailEvent>([
      [
        'stored-self-send-1',
        createStoredEvent({
          id: 'stored-self-send-1',
          svixId: 'svix-self-send-1',
          emailId: 'received-email-self-send-1',
        }),
      ],
      [
        'stored-reply-1',
        createStoredEvent({
          id: 'stored-reply-1',
          svixId: 'svix-reply-1',
          emailId: 'received-email-reply-1',
          subject: 'Re: Cerere organizare dezbatere publica',
        }),
      ],
    ]);

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(createSelfSendMatch());
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences(messageReferences: string[]) {
          const matches = [...storedEvents.values()]
            .filter(
              (event) =>
                typeof event.messageId === 'string' &&
                messageReferences.includes(event.messageId) &&
                event.threadKey !== null
            )
            .map((event) => event.threadKey);

          const uniqueMatches = [...new Set(matches)];
          return ok(uniqueMatches.length === 1 ? (uniqueMatches[0] ?? null) : null);
        },
        async updateStoredEvent(
          id: string,
          input: {
            threadKey?: string | null;
            messageId?: string | null;
            metadata?: Record<string, unknown>;
          }
        ) {
          const existing = storedEvents.get(id);
          if (existing === undefined) {
            throw new Error(`Unknown stored event: ${id}`);
          }

          const next = createStoredEvent({
            ...existing,
            ...(input.threadKey !== undefined ? { threadKey: input.threadKey } : {}),
            ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          });
          storedEvents.set(id, next);
          return ok(next);
        },
      },
      receivedEmailFetcher: {
        async getReceivedEmail(emailId: string) {
          if (emailId === 'received-email-self-send-1') {
            return ok({
              id: 'received-email-self-send-1',
              to: ['contact@primarie.ro'],
              from: 'ngo@example.com',
              createdAt: new Date('2026-03-25T12:00:00.000Z'),
              subject,
              html: '<p>Body</p>',
              text: 'Body',
              headers: { 'message-id': '<self-send-message-1>' },
              bcc: [],
              cc: [captureAddress],
              replyTo: [],
              messageId: '<self-send-message-1>',
              attachments: [],
              rawDownloadUrl: null,
              rawExpiresAt: null,
            });
          }

          if (emailId === 'received-email-reply-1') {
            return ok({
              id: 'received-email-reply-1',
              to: [captureAddress],
              from: 'office@primarie.ro',
              createdAt: new Date('2026-03-25T13:00:00.000Z'),
              subject: 'Re: Cerere organizare dezbatere publica',
              html: '<p>Raspuns</p>',
              text: 'Raspuns',
              headers: {
                'in-reply-to': '<self-send-message-1>',
                references: '<self-send-message-1> <something-else>',
                'message-id': '<reply-message-1>',
              },
              bcc: [],
              cc: [],
              replyTo: [],
              messageId: '<reply-message-1>',
              attachments: [],
              rawDownloadUrl: null,
              rawExpiresAt: null,
            });
          }

          throw new Error(`Unexpected email fetch: ${emailId}`);
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-self-send-1',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: storedEvents.get('stored-self-send-1')!,
    });

    expect(storedEvents.get('stored-self-send-1')?.messageId).toBe('<self-send-message-1>');
    expect(storedEvents.get('stored-self-send-1')?.threadKey).toEqual(expect.any(String));

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T13:00:01.000Z',
        data: {
          email_id: 'received-email-reply-1',
          from: 'office@primarie.ro',
          to: [captureAddress],
          cc: [],
          bcc: [],
          subject: 'Re: Cerere organizare dezbatere publica',
          created_at: '2026-03-25T13:00:00.000Z',
        },
      },
      storedEvent: storedEvents.get('stored-reply-1')!,
    });

    const createdThread = await repo.findSelfSendThreadByInteractionKey(interactionKey);
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.record.correspondence).toHaveLength(2);
      expect(createdThread.value?.record.correspondence[1]?.direction).toBe('inbound');
      expect(createdThread.value?.phase).toBe('reply_received_unreviewed');
    }

    expect(storedEvents.get('stored-reply-1')?.metadata).toEqual({
      matchStatus: 'matched',
      matchReason: 'matched_by_headers',
      matchedBy: 'headers',
    });
  });

  it('matches a platform-send thread by recipient and normalized subject when headers are missing', async () => {
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-platform-recipient-1',
          entityCui: '12345678',
          threadKey: 'thread-key-platform-recipient-1',
          phase: 'awaiting_reply',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Comuna Test',
            institutionEmail: 'contact@primarie.ro',
            correspondence: [
              createPlatformSendOutboundEntry({
                resendEmailId: 'email-platform-1',
                messageId: null,
                subject:
                  'Cerere dezbatere buget local - Comuna Test [teu:thread-key-platform-recipient-1]',
              }),
            ],
          }),
        }),
      ],
    });

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(null);
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-platform-reply-1',
            to: [captureAddress],
            from: 'office@primarie.ro',
            createdAt: new Date('2026-03-25T13:00:00.000Z'),
            subject: 'Re: Cerere dezbatere buget local - Comuna Test',
            html: '<p>Raspuns</p>',
            text: 'Raspuns',
            headers: {
              'message-id': '<message-platform-reply-1>',
              'authentication-results':
                'mx.example; dkim=pass header.d=primarie.ro; dmarc=pass header.from=primarie.ro',
            },
            bcc: [],
            cc: ['contact@primarie.ro'],
            replyTo: [],
            messageId: '<message-platform-reply-1>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T13:00:01.000Z',
        data: {
          email_id: 'received-email-platform-reply-1',
          from: 'office@primarie.ro',
          to: [captureAddress],
          cc: ['contact@primarie.ro'],
          bcc: [],
          subject: 'Re: Cerere dezbatere buget local - Comuna Test',
          created_at: '2026-03-25T13:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-platform-reply-1',
        svixId: 'svix-platform-reply-1',
        emailId: 'received-email-platform-reply-1',
        fromAddress: 'office@primarie.ro',
        toAddresses: [captureAddress],
        ccAddresses: ['contact@primarie.ro'],
        subject: 'Re: Cerere dezbatere buget local - Comuna Test',
      }),
    });

    const thread = await repo.findThreadById('thread-platform-recipient-1');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('reply_received_unreviewed');
      expect(thread.value?.record.correspondence).toHaveLength(2);
      expect(thread.value?.record.correspondence[1]?.direction).toBe('inbound');
      expect(thread.value?.lastReplyAt?.toISOString()).toBe('2026-03-25T13:00:00.000Z');
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-platform-reply-1', {
      threadKey: 'thread-key-platform-recipient-1',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'matched_by_recipient_and_subject',
        matchedBy: 'recipient',
      },
    });
  });

  it('prefers self-send correlation over recipient fallback when capture address is in cc', async () => {
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-platform-1',
          entityCui: '12345678',
          threadKey: 'thread-key-platform-1',
          phase: 'awaiting_reply',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
            subject,
            institutionEmail: 'contact@primarie.ro',
            correspondence: [],
          }),
        }),
      ],
    });

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(createSelfSendMatch());
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-self-send-priority',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject,
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-self-send-priority>' },
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<message-self-send-priority>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      selfSendApprovalService: {
        approvePendingRecord: async () => ok(undefined),
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-self-send-priority',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-self-send-priority',
        svixId: 'svix-self-send-priority',
        emailId: 'received-email-self-send-priority',
        fromAddress: 'ngo@example.com',
        toAddresses: ['contact@primarie.ro'],
        ccAddresses: [captureAddress],
        subject,
      }),
    });

    const platformThread = await repo.findThreadById('thread-platform-1');
    expect(platformThread.isOk()).toBe(true);
    if (platformThread.isOk()) {
      expect(platformThread.value?.record.submissionPath).toBe('platform_send');
      expect(platformThread.value?.record.correspondence).toHaveLength(0);
      expect(platformThread.value?.phase).toBe('awaiting_reply');
    }

    const selfSendThread = await repo.findSelfSendThreadByInteractionKey(interactionKey);
    expect(selfSendThread.isOk()).toBe(true);
    if (selfSendThread.isOk()) {
      expect(selfSendThread.value?.record.submissionPath).toBe('self_send_cc');
      expect(selfSendThread.value?.record.correspondence).toHaveLength(1);
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-self-send-priority', {
      threadKey: expect.any(String),
      messageId: '<message-self-send-priority>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'created_from_interaction_key_and_official_email',
        matchedBy: 'interaction_key',
      },
    });
  });

  it('does not use recipient fallback when the sender is same-domain but unauthenticated', async () => {
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-platform-sender-check',
          entityCui: '12345678',
          threadKey: 'thread-key-platform-sender-check',
          phase: 'awaiting_reply',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Comuna Test',
            institutionEmail: 'contact@primarie.ro',
            correspondence: [],
          }),
        }),
      ],
    });

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails(emails) {
          if (emails.includes('contact@primarie.ro')) {
            return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
          }

          return ok([]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(null);
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-platform-reply-spoofed',
            to: [captureAddress],
            from: 'office@primarie.ro',
            createdAt: new Date('2026-03-25T13:00:00.000Z'),
            subject: 'Re: Cerere dezbatere buget local - Comuna Test',
            html: '<p>Forwarded</p>',
            text: 'Forwarded',
            headers: { 'message-id': '<message-platform-reply-spoofed>' },
            bcc: [],
            cc: ['contact@primarie.ro'],
            replyTo: [],
            messageId: '<message-platform-reply-spoofed>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T13:00:01.000Z',
        data: {
          email_id: 'received-email-platform-reply-spoofed',
          from: 'office@primarie.ro',
          to: [captureAddress],
          cc: ['contact@primarie.ro'],
          bcc: [],
          subject: 'Re: Cerere dezbatere buget local - Comuna Test',
          created_at: '2026-03-25T13:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-platform-reply-spoofed',
        svixId: 'svix-platform-reply-spoofed',
        emailId: 'received-email-platform-reply-spoofed',
        fromAddress: 'office@primarie.ro',
        toAddresses: [captureAddress],
        ccAddresses: ['contact@primarie.ro'],
        subject: 'Re: Cerere dezbatere buget local - Comuna Test',
      }),
    });

    const thread = await repo.findThreadById('thread-platform-sender-check');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('awaiting_reply');
      expect(thread.value?.record.correspondence).toHaveLength(0);
    }

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-platform-reply-spoofed', {
      metadata: expect.objectContaining({
        matchStatus: 'unmatched',
        matchReason: 'platform_reply_sender_mismatch',
        matchedBy: 'recipient',
        candidateEntityCuis: ['12345678'],
      }),
    });
  });

  it('flags unresolved third-party emails when no interaction key matches', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([]);
        },
      },
      selfSendContextLookup: {
        async findByInteractionKey() {
          return ok(null);
        },
      },
      emailEventsRepo: {
        async insert() {
          throw new Error('not used');
        },
        async findBySvixId() {
          throw new Error('not used');
        },
        async findThreadKeyByMessageReferences() {
          return ok(null);
        },
        updateStoredEvent,
      },
      receivedEmailFetcher: {
        async getReceivedEmail() {
          return ok({
            id: 'received-email-third-party',
            to: ['contact@primarie.ro'],
            from: 'third-party@example.com',
            createdAt: new Date('2026-03-25T14:00:00.000Z'),
            subject,
            html: null,
            text: 'Body',
            headers: {},
            bcc: [],
            cc: [captureAddress],
            replyTo: [],
            messageId: '<third-party-message>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress,
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T14:00:01.000Z',
        data: {
          email_id: 'received-email-third-party',
          from: 'third-party@example.com',
          to: ['contact@primarie.ro'],
          cc: [captureAddress],
          bcc: [],
          subject,
          created_at: '2026-03-25T14:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-third-party',
        svixId: 'svix-third-party',
        emailId: 'received-email-third-party',
        fromAddress: 'third-party@example.com',
      }),
    });

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-third-party', {
      metadata: expect.objectContaining({
        matchStatus: 'unmatched',
        matchReason: 'interaction_key_not_found',
        interactionKey: buildSelfSendInteractionKey('third-party@example.com', subject),
        rawMessage: expect.any(Object),
      }),
    });
    expect(repo.snapshotThreads()).toHaveLength(0);
  });
});
