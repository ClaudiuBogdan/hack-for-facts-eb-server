import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  createDatabaseError,
  type EntityProfileRepository,
  type EntityRepository,
} from '@/modules/entity/index.js';
import { makePublicDebateRequestUserEventHandler } from '@/modules/user-events/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../../fixtures/fakes.js';
import {
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../institution-correspondence/fake-repo.js';

import type {
  CorrespondenceEmailSender,
  InstitutionCorrespondenceRepository,
  PublicDebateEntitySubscriptionService,
} from '@/modules/institution-correspondence/index.js';
import type {
  LearningProgressRecordRow,
  LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

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
  institutionEmail?: string;
  submissionPath: 'send_yourself' | 'request_platform';
  preparedSubject?: string | null;
  updatedAt?: string;
  key?: string;
  extraPayloadFields?: Record<string, unknown>;
}) {
  const entityCui = input.entityCui ?? '12345678';
  const institutionEmail = input.institutionEmail ?? 'contact@primarie.ro';
  const preparedSubject =
    input.preparedSubject ??
    (input.submissionPath === 'send_yourself'
      ? 'Cerere organizare dezbatere publica - Oras Test - buget local 2026'
      : null);
  const updatedAt = input.updatedAt ?? '2026-03-31T10:00:00.000Z';

  return createTestInteractiveRecord({
    key: input.key ?? `funky:interaction:public_debate_request::entity:${entityCui}`,
    interactionId: 'funky:interaction:public_debate_request',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    completionRule: { type: 'resolved' },
    scope: { type: 'entity', entityCui },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          primariaEmail: institutionEmail,
          isNgo: true,
          organizationName: 'Asociatia Test',
          organizationLegalAddress: null,
          organizationRegistrationNumber: null,
          organizationFiscalCode: null,
          legalRepresentativeName: null,
          legalRepresentativeRole: null,
          ngoSenderEmail: input.submissionPath === 'send_yourself' ? 'ngo@example.com' : null,
          preparedSubject,
          threadKey: null,
          submissionPath: input.submissionPath,
          submittedAt: updatedAt,
          ...(input.extraPayloadFields ?? {}),
        },
      },
    },
    result: null,
    updatedAt,
    submittedAt: updatedAt,
  });
}

function makeTestEntityProfileRepo(
  officialEmail: string | null = 'contact@primarie.ro'
): EntityProfileRepository {
  return {
    async getByEntityCui() {
      return ok({
        institution_type: null,
        website_url: null,
        official_email: officialEmail,
        phone_primary: null,
        address_raw: null,
        address_locality: null,
        county_code: null,
        county_name: null,
        leader_name: null,
        leader_title: null,
        leader_party: null,
        scraped_at: '2026-03-31T10:00:00.000Z',
        extraction_confidence: null,
      });
    },
    async getByEntityCuis() {
      return ok(new Map());
    },
  };
}

function makeTestEntityRepo(entityName = 'Oras Test'): EntityRepository {
  return {
    async getById(cui) {
      return ok({
        cui,
        name: entityName,
        entity_type: null,
        default_report_type: 'Executie bugetara detaliata',
        uat_id: null,
        is_uat: true,
        address: null,
        last_updated: null,
        main_creditor_1_cui: null,
        main_creditor_2_cui: null,
      });
    },
    async getByIds() {
      return ok(new Map());
    },
    async getAll() {
      return ok({
        nodes: [],
        pageInfo: {
          totalCount: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
    },
    async getChildren() {
      return ok([]);
    },
    async getParents() {
      return ok([]);
    },
    async getCountyEntity() {
      return ok(null);
    },
  };
}

function makeFailingEntityRepo(): EntityRepository {
  return {
    async getById() {
      return err(createDatabaseError('Entity lookup failed'));
    },
    async getByIds() {
      return ok(new Map());
    },
    async getAll() {
      return ok({
        nodes: [],
        pageInfo: {
          totalCount: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
    },
    async getChildren() {
      return ok([]);
    },
    async getParents() {
      return ok([]);
    },
    async getCountyEntity() {
      return ok(null);
    },
  };
}

function createHandler(input: {
  learningProgressRepo?: LearningProgressRepository;
  entityRepo?: EntityRepository;
  entityProfileRepo?: EntityProfileRepository;
  correspondenceRepo?: InstitutionCorrespondenceRepository;
  subscriptionService?: PublicDebateEntitySubscriptionService;
  send?: CorrespondenceEmailSender['send'];
}) {
  const send =
    input.send ??
    (async () => {
      return ok({ emailId: 'email-1' });
    });

  return makePublicDebateRequestUserEventHandler({
    learningProgressRepo: input.learningProgressRepo ?? makeFakeLearningProgressRepo(),
    entityRepo: input.entityRepo ?? makeTestEntityRepo(),
    entityProfileRepo: input.entityProfileRepo ?? makeTestEntityProfileRepo(),
    repo: input.correspondenceRepo ?? makeInMemoryCorrespondenceRepo(),
    emailSender: {
      getFromAddress() {
        return 'noreply@transparenta.eu';
      },
      async send(params) {
        return send(params);
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
    ...(input.subscriptionService !== undefined
      ? { subscriptionService: input.subscriptionService }
      : {}),
    logger: pinoLogger({ level: 'silent' }),
  });
}

describe('makePublicDebateRequestUserEventHandler', () => {
  it('matches only interactive.updated user events', () => {
    const handler = createHandler({});

    expect(
      handler.matches({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'interactive.updated',
        occurredAt: '2026-03-31T10:00:00.000Z',
        recordKey: 'funky:interaction:public_debate_request::entity:12345678',
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

  it('sends and approves the record when the submitted email matches the official entity profile email', async () => {
    const sentEmails: unknown[] = [];
    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      correspondenceRepo,
      entityProfileRepo: makeTestEntityProfileRepo('contact@primarie.ro'),
      send: async (params) => {
        sentEmails.push(params);
        return ok({ emailId: 'email-1' });
      },
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
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('resolved');
    expect(storedRecord?.record.review?.status).toBe('approved');
  });

  it('accepts the richer client payload shape and still sends the request', async () => {
    const sentEmails: unknown[] = [];
    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
      extraPayloadFields: {
        isNgo: false,
        organizationName: null,
        organizationLegalAddress: null,
        organizationRegistrationNumber: null,
        organizationFiscalCode: null,
        legalRepresentativeName: null,
        legalRepresentativeRole: null,
      },
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      correspondenceRepo,
      entityProfileRepo: makeTestEntityProfileRepo('contact@primarie.ro'),
      send: async (params) => {
        sentEmails.push(params);
        return ok({ emailId: 'email-1' });
      },
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
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('resolved');
    expect(storedRecord?.record.review?.status).toBe('approved');
  });

  it('skips safely when the record is missing', async () => {
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      correspondenceRepo,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: '2026-03-31T10:00:00.000Z',
      recordKey: 'funky:interaction:public_debate_request::entity:12345678',
    });

    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
  });

  it('throws when loading the learning progress record fails', async () => {
    const handler = createHandler({
      learningProgressRepo: makeFakeLearningProgressRepo({
        simulateDbError: true,
      }),
    });

    await expect(
      handler.handle({
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'interactive.updated',
        occurredAt: '2026-03-31T10:00:00.000Z',
        recordKey: 'funky:interaction:public_debate_request::entity:12345678',
      })
    ).rejects.toThrow('Simulated database error');
  });

  it('does not send platform email for send_yourself submissions', async () => {
    const record = createDebateRequestRecord({
      submissionPath: 'send_yourself',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const handler = createHandler({
      learningProgressRepo,
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
  });

  it('subscribes the user for send_yourself submissions without sending a platform email', async () => {
    const record = createDebateRequestRecord({
      submissionPath: 'send_yourself',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const ensureSubscribed = vi.fn(async () => ok(undefined));
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const handler = createHandler({
      learningProgressRepo,
      subscriptionService: {
        ensureSubscribed,
      },
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(ensureSubscribed).toHaveBeenCalledWith('user-1', '12345678');
    expect(send).not.toHaveBeenCalled();
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('pending');
    expect(storedRecord?.record.review).toBeUndefined();
  });

  it('approves the record without sending when a platform-send thread already exists', async () => {
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
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const handler = createHandler({
      learningProgressRepo,
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(1);
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('resolved');
    expect(storedRecord?.record.review?.status).toBe('approved');
  });

  it('reuses an existing thread even when entity lookup is unavailable', async () => {
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
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const handler = createHandler({
      learningProgressRepo,
      entityRepo: makeFailingEntityRepo(),
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(1);
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('resolved');
    expect(storedRecord?.record.review?.status).toBe('approved');
  });

  it('throws when the downstream send fails with a retryable error so the queue can retry', async () => {
    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      correspondenceRepo,
      send: async () => {
        return err({
          type: 'SERVER' as const,
          message: 'Provider send failed',
          retryable: true,
        });
      },
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

    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('pending');
    expect(storedRecord?.record.review).toBeUndefined();
  });

  it('rejects invalid institution emails without sending', async () => {
    const record = createDebateRequestRecord({
      institutionEmail: 'not-an-email',
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('failed');
    expect(storedRecord?.record.review?.status).toBe('rejected');
    expect(storedRecord?.record.review?.feedbackText).toBe(
      'The submitted city hall email is not a valid email address.'
    );
  });

  it('rejects invalid institution emails without requiring entity lookup', async () => {
    const record = createDebateRequestRecord({
      institutionEmail: 'not-an-email',
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      entityRepo: makeFailingEntityRepo(),
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('failed');
    expect(storedRecord?.record.review?.status).toBe('rejected');
  });

  it('keeps the record pending when the submitted email mismatches the official profile email', async () => {
    const record = createDebateRequestRecord({
      institutionEmail: 'different@primarie.ro',
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      entityProfileRepo: makeTestEntityProfileRepo('contact@primarie.ro'),
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('pending');
    expect(storedRecord?.record.review).toBeUndefined();
  });

  it('keeps the record pending on official-email mismatch without requiring entity lookup', async () => {
    const record = createDebateRequestRecord({
      institutionEmail: 'different@primarie.ro',
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      entityRepo: makeFailingEntityRepo(),
      entityProfileRepo: makeTestEntityProfileRepo('contact@primarie.ro'),
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('pending');
    expect(storedRecord?.record.review).toBeUndefined();
  });

  it('keeps the record pending when the entity profile has no official email', async () => {
    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeLearningRow('user-1', record)]]]),
    });
    const send = vi.fn(async () => ok({ emailId: 'email-1' }));
    const correspondenceRepo = makeInMemoryCorrespondenceRepo();
    const handler = createHandler({
      learningProgressRepo,
      entityProfileRepo: makeTestEntityProfileRepo(null),
      correspondenceRepo,
      send,
    });

    await handler.handle({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-1',
      eventType: 'interactive.updated',
      occurredAt: record.updatedAt,
      recordKey: record.key,
    });

    expect(send).not.toHaveBeenCalled();
    expect(correspondenceRepo.snapshotThreads()).toHaveLength(0);
    const storedRows = await learningProgressRepo.getRecords('user-1');
    expect(storedRows.isOk()).toBe(true);
    const storedRecord = storedRows._unsafeUnwrap()[0];
    expect(storedRecord?.record.phase).toBe('pending');
    expect(storedRecord?.record.review).toBeUndefined();
  });
});
