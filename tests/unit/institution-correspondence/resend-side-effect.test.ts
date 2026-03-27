import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  makeInstitutionCorrespondenceResendSideEffect,
  type PublicDebateSelfSendContext,
} from '@/modules/institution-correspondence/index.js';

import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

import type { StoredResendEmailEvent } from '@/modules/resend-webhooks/index.js';

const testLogger = pinoLogger({ level: 'silent' });

const createSelfSendContext = (
  overrides: Partial<PublicDebateSelfSendContext> = {}
): PublicDebateSelfSendContext => ({
  userId: overrides.userId ?? 'user-1',
  recordKey: overrides.recordKey ?? 'campaign:debate-request::entity:12345678',
  entityCui: overrides.entityCui ?? '12345678',
  institutionEmail: overrides.institutionEmail ?? 'contact@primarie.ro',
  requesterOrganizationName: overrides.requesterOrganizationName ?? 'Asociatia Test',
  ngoSenderEmail: overrides.ngoSenderEmail ?? null,
  threadKey: overrides.threadKey ?? 'thread-key-1',
  submittedAt: overrides.submittedAt ?? '2026-03-25T12:00:00.000Z',
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
  fromAddress: 'citizen@example.com',
  toAddresses: ['contact@primarie.ro'],
  ccAddresses: ['debate@transparenta.test'],
  bccAddresses: [],
  messageId: null,
  subject: 'Solicitare [teu:thread-key-1]',
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
  it('creates a self-send thread from subject key, interaction context, and official email lookup', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const updateStoredEvent = vi.fn().mockResolvedValue(
      ok(
        createStoredEvent({
          threadKey: 'thread-key-1',
          messageId: '<message-1>',
          metadata: { matchStatus: 'matched' },
        })
      )
    );

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
          return ok(createSelfSendContext());
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
            from: 'citizen@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject: 'Solicitare [teu:thread-key-1]',
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-1>' },
            bcc: [],
            cc: ['debate@transparenta.test'],
            replyTo: [],
            messageId: '<message-1>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-1',
          from: 'citizen@example.com',
          to: ['contact@primarie.ro'],
          cc: ['debate@transparenta.test'],
          bcc: [],
          subject: 'Solicitare [teu:thread-key-1]',
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent(),
    });

    const createdThread = await repo.findThreadByKey('thread-key-1');
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.record.submissionPath).toBe('self_send_cc');
      expect(createdThread.value?.phase).toBe('awaiting_reply');
      expect(createdThread.value?.record.institutionEmail).toBe('contact@primarie.ro');
      expect(createdThread.value?.record.ownerUserId).toBe('user-1');
      expect(createdThread.value?.record.requesterOrganizationName).toBe('Asociatia Test');
      expect(createdThread.value?.record.metadata).toEqual({
        sourceInteractionRecordKey: 'campaign:debate-request::entity:12345678',
        expectedNgoSenderEmail: null,
        capturedFromAddress: 'citizen@example.com',
        senderEmailVerified: false,
      });
      expect(createdThread.value?.record.correspondence).toHaveLength(1);
      expect(createdThread.value?.record.correspondence[0]?.direction).toBe('outbound');
    }
    expect(updateStoredEvent).toHaveBeenCalledTimes(1);
    expect(updateStoredEvent).toHaveBeenCalledWith('stored-1', {
      threadKey: 'thread-key-1',
      messageId: '<message-1>',
      metadata: {
        matchStatus: 'matched',
        matchReason: 'created_from_subject_official_email_and_interaction',
        matchedBy: 'subject_official_email',
      },
    });
  });

  it('marks senderEmailVerified when the captured sender matches the expected NGO email', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const updateStoredEvent = vi.fn().mockResolvedValue(
      ok(
        createStoredEvent({
          threadKey: 'thread-key-ngo-match',
          metadata: { matchStatus: 'matched' },
        })
      )
    );

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
          return ok(
            createSelfSendContext({
              threadKey: 'thread-key-ngo-match',
              ngoSenderEmail: 'ngo@example.com',
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
            id: 'received-email-ngo-match',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject: 'Solicitare [teu:thread-key-ngo-match]',
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-ngo-match>' },
            bcc: [],
            cc: ['debate@transparenta.test'],
            replyTo: [],
            messageId: '<message-ngo-match>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-ngo-match',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: ['debate@transparenta.test'],
          bcc: [],
          subject: 'Solicitare [teu:thread-key-ngo-match]',
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-ngo-match',
        svixId: 'svix-ngo-match',
        emailId: 'received-email-ngo-match',
        subject: 'Solicitare [teu:thread-key-ngo-match]',
      }),
    });

    const createdThread = await repo.findThreadByKey('thread-key-ngo-match');
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.record.metadata).toEqual({
        sourceInteractionRecordKey: 'campaign:debate-request::entity:12345678',
        expectedNgoSenderEmail: 'ngo@example.com',
        capturedFromAddress: 'ngo@example.com',
        senderEmailVerified: true,
      });
    }
  });

  it('flags sender email mismatches while still creating the self-send thread', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const updateStoredEvent = vi.fn().mockResolvedValue(
      ok(
        createStoredEvent({
          threadKey: 'thread-key-ngo-mismatch',
          metadata: { matchStatus: 'matched' },
        })
      )
    );

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
          return ok(
            createSelfSendContext({
              threadKey: 'thread-key-ngo-mismatch',
              ngoSenderEmail: 'ngo@example.com',
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
            id: 'received-email-ngo-mismatch',
            to: ['contact@primarie.ro'],
            from: 'different@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject: 'Solicitare [teu:thread-key-ngo-mismatch]',
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-ngo-mismatch>' },
            bcc: [],
            cc: ['debate@transparenta.test'],
            replyTo: [],
            messageId: '<message-ngo-mismatch>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-ngo-mismatch',
          from: 'different@example.com',
          to: ['contact@primarie.ro'],
          cc: ['debate@transparenta.test'],
          bcc: [],
          subject: 'Solicitare [teu:thread-key-ngo-mismatch]',
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-ngo-mismatch',
        svixId: 'svix-ngo-mismatch',
        emailId: 'received-email-ngo-mismatch',
        subject: 'Solicitare [teu:thread-key-ngo-mismatch]',
      }),
    });

    const createdThread = await repo.findThreadByKey('thread-key-ngo-mismatch');
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.record.metadata).toEqual({
        sourceInteractionRecordKey: 'campaign:debate-request::entity:12345678',
        expectedNgoSenderEmail: 'ngo@example.com',
        capturedFromAddress: 'different@example.com',
        senderEmailVerified: false,
        senderEmailMismatch: true,
        senderEmailMismatchReason: 'from_address_mismatch',
      });
    }
  });

  it('creates the self-send thread even when a platform-send thread already exists for the entity', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          entityCui: '12345678',
          threadKey: 'platform-thread-key',
          record: createThreadAggregateRecord({
            submissionPath: 'platform_send',
          }),
        }),
      ],
    });
    const updateStoredEvent = vi.fn().mockResolvedValue(
      ok(
        createStoredEvent({
          threadKey: 'thread-key-self-send',
          metadata: { matchStatus: 'matched' },
        })
      )
    );

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
          return ok(
            createSelfSendContext({
              threadKey: 'thread-key-self-send',
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
            id: 'received-email-self-send',
            to: ['contact@primarie.ro'],
            from: 'citizen@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject: 'Solicitare [teu:thread-key-self-send]',
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<message-self-send>' },
            bcc: [],
            cc: ['debate@transparenta.test'],
            replyTo: [],
            messageId: '<message-self-send>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-self-send',
          from: 'citizen@example.com',
          to: ['contact@primarie.ro'],
          cc: ['debate@transparenta.test'],
          bcc: [],
          subject: 'Solicitare [teu:thread-key-self-send]',
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-self-send',
        svixId: 'svix-self-send',
        emailId: 'received-email-self-send',
        subject: 'Solicitare [teu:thread-key-self-send]',
      }),
    });

    expect(repo.snapshotThreads()).toHaveLength(2);
    const selfSendThread = await repo.findThreadByKey('thread-key-self-send');
    expect(selfSendThread.isOk()).toBe(true);
    if (selfSendThread.isOk()) {
      expect(selfSendThread.value?.record.submissionPath).toBe('self_send_cc');
    }
  });

  it('matches a reply by headers through the resend-webhooks lookup and moves the thread to review', async () => {
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
    const updateStoredEvent = vi.fn().mockResolvedValue(
      ok(
        createStoredEvent({
          id: 'stored-2',
          svixId: 'svix-2',
          emailId: 'received-email-2',
          fromAddress: 'office@primarie.ro',
          toAddresses: ['debate@transparenta.test'],
          messageId: '<message-2>',
          subject: 'Re: Subject [teu:thread-key-1]',
          emailCreatedAt: new Date('2026-03-25T13:00:00.000Z'),
          threadKey: 'thread-key-1',
          metadata: { matchStatus: 'matched' },
        })
      )
    );

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
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
            to: ['debate@transparenta.test'],
            from: 'office@primarie.ro',
            createdAt: new Date('2026-03-25T13:00:00.000Z'),
            subject: 'Re: Subject [teu:thread-key-1]',
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
      captureAddress: 'debate@transparenta.test',
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
          to: ['debate@transparenta.test'],
          cc: [],
          bcc: [],
          subject: 'Re: Subject [teu:thread-key-1]',
          created_at: '2026-03-25T13:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-2',
        svixId: 'svix-2',
        emailId: 'received-email-2',
        fromAddress: 'office@primarie.ro',
        toAddresses: ['debate@transparenta.test'],
        subject: 'Re: Subject [teu:thread-key-1]',
        emailCreatedAt: new Date('2026-03-25T13:00:00.000Z'),
      }),
    });

    const thread = await repo.findThreadById('thread-1');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('reply_received_unreviewed');
      expect(thread.value?.lastReplyAt?.toISOString()).toBe('2026-03-25T13:00:00.000Z');
      expect(thread.value?.record.correspondence).toHaveLength(2);
      expect(thread.value?.record.correspondence[1]?.direction).toBe('inbound');
    }
    expect(updateStoredEvent).toHaveBeenCalledTimes(1);
  });

  it('persists fetched self-send message ids so header-only follow-up replies can match', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const storedEvents = new Map<string, StoredResendEmailEvent>([
      [
        'stored-self-send-1',
        createStoredEvent({
          id: 'stored-self-send-1',
          svixId: 'svix-self-send-1',
          emailId: 'received-email-self-send-1',
          subject: 'Solicitare [teu:thread-key-follow-up]',
        }),
      ],
      [
        'stored-reply-1',
        createStoredEvent({
          id: 'stored-reply-1',
          svixId: 'svix-reply-1',
          emailId: 'received-email-reply-1',
          subject: 'Re: Solicitare',
        }),
      ],
    ]);

    const emailEventsRepo = {
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
    };

    const receivedEmailFetcher = {
      async getReceivedEmail(emailId: string) {
        if (emailId === 'received-email-self-send-1') {
          return ok({
            id: 'received-email-self-send-1',
            to: ['contact@primarie.ro'],
            from: 'citizen@example.com',
            createdAt: new Date('2026-03-25T12:00:00.000Z'),
            subject: 'Solicitare [teu:thread-key-follow-up]',
            html: '<p>Body</p>',
            text: 'Body',
            headers: { 'message-id': '<self-send-message-1>' },
            bcc: [],
            cc: ['debate@transparenta.test'],
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
            to: ['debate@transparenta.test'],
            from: 'office@primarie.ro',
            createdAt: new Date('2026-03-25T13:00:00.000Z'),
            subject: 'Re: Solicitare',
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
    };

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([{ entityCui: '12345678', officialEmail: 'contact@primarie.ro' }]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
          return ok(
            createSelfSendContext({
              threadKey: 'thread-key-follow-up',
            })
          );
        },
      },
      emailEventsRepo,
      receivedEmailFetcher,
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T12:00:01.000Z',
        data: {
          email_id: 'received-email-self-send-1',
          from: 'citizen@example.com',
          to: ['contact@primarie.ro'],
          cc: ['debate@transparenta.test'],
          bcc: [],
          subject: 'Solicitare [teu:thread-key-follow-up]',
          created_at: '2026-03-25T12:00:00.000Z',
        },
      },
      storedEvent: storedEvents.get('stored-self-send-1')!,
    });

    const persistedSelfSendEvent = storedEvents.get('stored-self-send-1');
    expect(persistedSelfSendEvent?.threadKey).toBe('thread-key-follow-up');
    expect(persistedSelfSendEvent?.messageId).toBe('<self-send-message-1>');

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T13:00:01.000Z',
        data: {
          email_id: 'received-email-reply-1',
          from: 'office@primarie.ro',
          to: ['debate@transparenta.test'],
          cc: [],
          bcc: [],
          subject: 'Re: Solicitare',
          created_at: '2026-03-25T13:00:00.000Z',
        },
      },
      storedEvent: storedEvents.get('stored-reply-1')!,
    });

    const createdThread = await repo.findThreadByKey('thread-key-follow-up');
    expect(createdThread.isOk()).toBe(true);
    if (createdThread.isOk()) {
      expect(createdThread.value?.record.correspondence).toHaveLength(2);
      expect(createdThread.value?.record.correspondence[1]?.direction).toBe('inbound');
      expect(createdThread.value?.phase).toBe('reply_received_unreviewed');
    }

    const persistedReplyEvent = storedEvents.get('stored-reply-1');
    expect(persistedReplyEvent?.threadKey).toBe('thread-key-follow-up');
    expect(persistedReplyEvent?.metadata).toEqual({
      matchStatus: 'matched',
      matchReason: 'matched_by_headers',
      matchedBy: 'headers',
    });
  });

  it('attaches the provider message_id back onto the outbound correspondence entry on email.sent', async () => {
    const existingThread = createThreadRecord({
      id: 'thread-1',
      threadKey: 'thread-key-1',
      record: createThreadAggregateRecord({
        correspondence: [
          createCorrespondenceEntry({
            id: 'entry-1',
            direction: 'outbound',
            source: 'platform_send',
            resendEmailId: 'outbound-email-1',
            messageId: null,
          }),
        ],
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({ threads: [existingThread] });

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
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
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.sent',
        created_at: '2026-03-25T13:00:01.000Z',
        data: {
          email_id: 'outbound-email-1',
          from: 'noreply@transparenta.eu',
          to: ['office@primarie.ro'],
          subject: 'Subject [teu:thread-key-1]',
          created_at: '2026-03-25T13:00:00.000Z',
          message_id: '<sent-message-1>',
        },
      },
      storedEvent: createStoredEvent({
        eventType: 'email.sent',
        emailId: 'outbound-email-1',
        messageId: '<sent-message-1>',
        threadKey: 'thread-key-1',
      }),
    });

    const thread = await repo.findThreadById('thread-1');
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.record.correspondence[0]?.messageId).toBe('<sent-message-1>');
    }
  });

  it('stores unmatched diagnostics when no thread key can be extracted', async () => {
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
        async findByThreadKey() {
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
            id: 'received-email-3',
            to: ['debate@transparenta.test'],
            from: 'office@primarie.ro',
            createdAt: new Date('2026-03-25T14:00:00.000Z'),
            subject: 'No key here',
            html: null,
            text: 'No key here',
            headers: {},
            bcc: [],
            cc: [],
            replyTo: [],
            messageId: '<message-3>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T14:00:01.000Z',
        data: {
          email_id: 'received-email-3',
          from: 'office@primarie.ro',
          to: ['debate@transparenta.test'],
          subject: 'No key here',
          created_at: '2026-03-25T14:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-3',
        svixId: 'svix-3',
        emailId: 'received-email-3',
        fromAddress: 'office@primarie.ro',
        toAddresses: ['debate@transparenta.test'],
        subject: 'No key here',
        emailCreatedAt: new Date('2026-03-25T14:00:00.000Z'),
      }),
    });

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-3', {
      metadata: expect.objectContaining({
        matchStatus: 'unmatched',
        matchReason: 'thread_key_missing',
        rawMessage: expect.any(Object),
      }),
    });
  });

  it('stores unmatched diagnostics when no submitted interaction matches the thread key', async () => {
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
        async findByThreadKey() {
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
            id: 'received-email-missing-context',
            to: ['contact@primarie.ro'],
            from: 'ngo@example.com',
            createdAt: new Date('2026-03-25T14:00:00.000Z'),
            subject: 'Solicitare [teu:thread-key-missing-context]',
            html: null,
            text: 'Body',
            headers: {},
            bcc: [],
            cc: ['debate@transparenta.test'],
            replyTo: [],
            messageId: '<message-missing-context>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T14:00:01.000Z',
        data: {
          email_id: 'received-email-missing-context',
          from: 'ngo@example.com',
          to: ['contact@primarie.ro'],
          cc: ['debate@transparenta.test'],
          bcc: [],
          subject: 'Solicitare [teu:thread-key-missing-context]',
          created_at: '2026-03-25T14:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-missing-context',
        svixId: 'svix-missing-context',
        emailId: 'received-email-missing-context',
        subject: 'Solicitare [teu:thread-key-missing-context]',
      }),
    });

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-missing-context', {
      metadata: expect.objectContaining({
        matchStatus: 'unmatched',
        matchReason: 'interaction_context_not_found',
        extractedThreadKey: 'thread-key-missing-context',
      }),
    });
    expect(repo.snapshotThreads()).toHaveLength(0);
  });

  it('stores ambiguous diagnostics when multiple entities match the official email lookup', async () => {
    const repo = makeInMemoryCorrespondenceRepo();
    const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));

    const sideEffect = makeInstitutionCorrespondenceResendSideEffect({
      repo,
      officialEmailLookup: {
        async findEntitiesByOfficialEmails() {
          return ok([
            { entityCui: '12345678', officialEmail: 'contact@primarie.ro' },
            { entityCui: '87654321', officialEmail: 'contact@primarie.ro' },
          ]);
        },
      },
      selfSendContextLookup: {
        async findByThreadKey() {
          return ok(createSelfSendContext());
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
            id: 'received-email-4',
            to: ['contact@primarie.ro'],
            from: 'citizen@example.com',
            createdAt: new Date('2026-03-25T15:00:00.000Z'),
            subject: 'Solicitare [teu:thread-key-4]',
            html: '<p>Body</p>',
            text: 'Body',
            headers: {},
            bcc: [],
            cc: ['debate@transparenta.test'],
            replyTo: [],
            messageId: '<message-4>',
            attachments: [],
            rawDownloadUrl: null,
            rawExpiresAt: null,
          });
        },
      },
      captureAddress: 'debate@transparenta.test',
      auditCcRecipients: [],
      logger: testLogger,
    });

    await sideEffect.handle({
      event: {
        type: 'email.received',
        created_at: '2026-03-25T15:00:01.000Z',
        data: {
          email_id: 'received-email-4',
          from: 'citizen@example.com',
          to: ['contact@primarie.ro'],
          cc: ['debate@transparenta.test'],
          bcc: [],
          subject: 'Solicitare [teu:thread-key-4]',
          created_at: '2026-03-25T15:00:00.000Z',
        },
      },
      storedEvent: createStoredEvent({
        id: 'stored-4',
        svixId: 'svix-4',
        emailId: 'received-email-4',
        subject: 'Solicitare [teu:thread-key-4]',
        emailCreatedAt: new Date('2026-03-25T15:00:00.000Z'),
      }),
    });

    expect(updateStoredEvent).toHaveBeenCalledWith('stored-4', {
      metadata: expect.objectContaining({
        matchStatus: 'ambiguous',
        matchReason: 'official_email_ambiguous',
        extractedThreadKey: 'thread-key-4',
        candidateEntityCuis: ['12345678', '87654321'],
      }),
    });
  });
});
