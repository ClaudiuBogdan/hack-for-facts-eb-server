import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import { PUBLIC_DEBATE_REQUEST_TYPE } from '@/modules/institution-correspondence/index.js';
import {
  makeLearningProgressRoutes,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';
import {
  createLearningProgressUserEventSyncHook,
  makePublicDebateRequestUserEventHandler,
  processUserEventJob,
  type UserEventJobPayload,
} from '@/modules/user-events/index.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  makeFakeLearningProgressRepo,
} from '../fixtures/fakes.js';
import {
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../unit/institution-correspondence/fake-repo.js';

import type { EntityProfileRepository } from '@/modules/entity/index.js';

function createDebateRequestRecord(input: {
  entityCui?: string;
  institutionEmail?: string;
  submissionPath: 'send_yourself' | 'request_platform';
  preparedSubject?: string | null;
  updatedAt?: string;
  submittedAt?: string | null;
  key?: string;
}) {
  const entityCui = input.entityCui ?? '12345678';
  const institutionEmail = input.institutionEmail ?? 'contact@primarie.ro';
  const preparedSubject =
    input.preparedSubject ??
    (input.submissionPath === 'send_yourself'
      ? 'Cerere organizare dezbatere publica - Oras Test - buget local 2026'
      : null);
  const updatedAt = input.updatedAt ?? '2026-03-26T10:00:00.000Z';
  const submittedAt = input.submittedAt ?? updatedAt;

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
          primariaEmail: institutionEmail,
          isNgo: true,
          organizationName: 'Asociatia Test',
          ngoSenderEmail: input.submissionPath === 'send_yourself' ? 'ngo@example.com' : null,
          preparedSubject,
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
        scraped_at: '2026-03-26T10:00:00.000Z',
        extraction_confidence: null,
      });
    },
    async getByEntityCuis() {
      return ok(new Map());
    },
  };
}

const createTestApp = async (options: {
  learningProgressRepo?: LearningProgressRepository;
  correspondenceRepo?: ReturnType<typeof makeInMemoryCorrespondenceRepo>;
  officialEmail?: string | null;
  sendError?: boolean;
}) => {
  const testAuth = createTestAuthProvider();
  const app = fastifyLib({ logger: false });
  const learningProgressRepo = options.learningProgressRepo ?? makeFakeLearningProgressRepo();
  const correspondenceRepo = options.correspondenceRepo ?? makeInMemoryCorrespondenceRepo();
  const sentEmails: Record<string, unknown>[] = [];
  const queuedJobs: UserEventJobPayload[] = [];
  const logger = pinoLogger({ level: 'silent' });
  const publicDebateHandler = makePublicDebateRequestUserEventHandler({
    learningProgressRepo,
    entityProfileRepo: makeTestEntityProfileRepo(
      options.officialEmail === undefined ? 'contact@primarie.ro' : options.officialEmail
    ),
    repo: correspondenceRepo,
    emailSender: {
      getFromAddress() {
        return 'noreply@transparenta.eu';
      },
      async send(params) {
        sentEmails.push(params as unknown as Record<string, unknown>);

        if (options.sendError === true) {
          return err({
            type: 'SERVER' as const,
            message: 'Provider send failed',
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
    logger,
  });

  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    void reply.status(statusCode).send({
      ok: false,
      error: error.code ?? error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
      retryable: false,
    });
  });

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

  await app.register(
    makeLearningProgressRoutes({
      learningProgressRepo,
      onSyncEventsApplied: createLearningProgressUserEventSyncHook({
        publisher: {
          async publish() {
            throw new Error('publish() should not be called in this integration test');
          },
          async publishMany(jobs) {
            queuedJobs.push(...jobs);
          },
        },
        logger,
      }),
    })
  );

  await app.ready();

  return {
    app,
    testAuth,
    learningProgressRepo,
    correspondenceRepo,
    sentEmails,
    queuedJobs,
    async processQueuedJobs() {
      while (queuedJobs.length > 0) {
        const nextJob = queuedJobs.shift();
        if (nextJob === undefined) {
          continue;
        }

        await processUserEventJob(
          {
            handlers: [publicDebateHandler],
            logger,
          },
          nextJob
        );
      }
    },
  };
};

describe('Public debate request dispatch via learning progress sync', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('stores the interaction and creates a platform-send thread for request_platform submissions', async () => {
    const setup = await createTestApp({});
    app = setup.app;

    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        data: {
          newEventsCount: 1,
          failedEvents: [],
        },
      })
    );

    const records = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()).toHaveLength(1);

    await setup.processQueuedJobs();
    expect(setup.sentEmails).toHaveLength(1);
    const threadResult = await setup.correspondenceRepo.findPlatformSendThreadByEntity({
      entityCui: '12345678',
      campaign: PUBLIC_DEBATE_REQUEST_TYPE,
    });
    expect(threadResult.isOk()).toBe(true);
    if (threadResult.isOk()) {
      expect(threadResult.value?.phase).toBe('awaiting_reply');
      expect(threadResult.value?.record.correspondence).toHaveLength(1);
    }

    const storedRows = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(storedRows.isOk()).toBe(true);
    expect(storedRows._unsafeUnwrap()[0]?.record.phase).toBe('resolved');
    expect(storedRows._unsafeUnwrap()[0]?.record.review?.status).toBe('approved');
  });

  it('stores the interaction and does not dispatch for send_yourself submissions', async () => {
    const setup = await createTestApp({});
    app = setup.app;

    const record = createDebateRequestRecord({
      submissionPath: 'send_yourself',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await setup.processQueuedJobs();
    expect(setup.sentEmails).toHaveLength(0);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(0);

    const storedRows = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(storedRows.isOk()).toBe(true);
    expect(storedRows._unsafeUnwrap()[0]?.record.phase).toBe('pending');
    expect(storedRows._unsafeUnwrap()[0]?.record.review).toBeUndefined();
  });

  it('stores the interaction and silently skips duplicate platform-send requests', async () => {
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
    const setup = await createTestApp({ correspondenceRepo });
    app = setup.app;

    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await setup.processQueuedJobs();
    expect(setup.sentEmails).toHaveLength(0);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(1);

    const storedRows = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(storedRows.isOk()).toBe(true);
    expect(storedRows._unsafeUnwrap()[0]?.record.phase).toBe('resolved');
    expect(storedRows._unsafeUnwrap()[0]?.record.review?.status).toBe('approved');
  });

  it('does not let an existing self-send thread block a platform send', async () => {
    const correspondenceRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          entityCui: '12345678',
          record: createThreadAggregateRecord({
            submissionPath: 'self_send_cc',
          }),
        }),
      ],
    });
    const setup = await createTestApp({ correspondenceRepo });
    app = setup.app;

    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await setup.processQueuedJobs();
    expect(setup.sentEmails).toHaveLength(1);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(2);

    const storedRows = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(storedRows.isOk()).toBe(true);
    expect(storedRows._unsafeUnwrap()[0]?.record.phase).toBe('resolved');
    expect(storedRows._unsafeUnwrap()[0]?.record.review?.status).toBe('approved');
  });

  it('returns 200, preserves the interaction as pending, and leaves the failed thread available for retry when send fails', async () => {
    const setup = await createTestApp({ sendError: true });
    app = setup.app;

    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await expect(setup.processQueuedJobs()).rejects.toThrow('Provider send failed');
    expect(setup.sentEmails).toHaveLength(1);

    const records = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()).toHaveLength(1);
    expect(records._unsafeUnwrap()[0]?.record.phase).toBe('pending');
    expect(records._unsafeUnwrap()[0]?.record.review).toBeUndefined();

    const threadResult = await setup.correspondenceRepo.findPlatformSendThreadByEntity({
      entityCui: '12345678',
      campaign: PUBLIC_DEBATE_REQUEST_TYPE,
    });
    expect(threadResult.isOk()).toBe(true);
    if (threadResult.isOk()) {
      expect(threadResult.value).toBeNull();
    }

    const failedThread = setup.correspondenceRepo
      .snapshotThreads()
      .find((thread) => thread.entityCui === '12345678' && thread.phase === 'failed');
    expect(failedThread).toBeDefined();
    expect(failedThread?.record.correspondence).toHaveLength(0);
  });

  it('returns the existing validation error and triggers no correspondence side effect for invalid batches', async () => {
    const setup = await createTestApp({});
    app = setup.app;

    const record = createDebateRequestRecord({
      submissionPath: 'request_platform',
    });
    const invalidRecord = {
      ...record,
      result: {
        outcome: null,
        evaluatedAt: '2026-03-26T10:00:00.000Z',
      },
    };

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: invalidRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-invalid-pending-result',
            payload: { record: invalidRecord },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        newEventsCount: 0,
        failedEvents: [
          {
            eventId: 'event-invalid-pending-result',
            errorType: 'InvalidEventError',
            message: `Interactive record "${invalidRecord.key}" cannot include result data while phase is "pending".`,
          },
        ],
      },
    });
    expect(setup.queuedJobs).toHaveLength(0);
    expect(setup.sentEmails).toHaveLength(0);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(0);
  });

  it('rejects invalid institution emails without dispatching the platform send', async () => {
    const setup = await createTestApp({});
    app = setup.app;

    const record = createDebateRequestRecord({
      institutionEmail: 'not-an-email',
      submissionPath: 'request_platform',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await setup.processQueuedJobs();
    expect(setup.sentEmails).toHaveLength(0);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(0);

    const storedRows = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(storedRows.isOk()).toBe(true);
    expect(storedRows._unsafeUnwrap()[0]?.record.phase).toBe('failed');
    expect(storedRows._unsafeUnwrap()[0]?.record.review?.status).toBe('rejected');
  });

  it('keeps valid mismatched institution emails pending for manual review', async () => {
    const setup = await createTestApp({
      officialEmail: 'official@primarie.ro',
    });
    app = setup.app;

    const record = createDebateRequestRecord({
      institutionEmail: 'submitted@primarie.ro',
      submissionPath: 'request_platform',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await setup.processQueuedJobs();
    expect(setup.sentEmails).toHaveLength(0);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(0);

    const storedRows = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(storedRows.isOk()).toBe(true);
    expect(storedRows._unsafeUnwrap()[0]?.record.phase).toBe('pending');
    expect(storedRows._unsafeUnwrap()[0]?.record.review).toBeUndefined();
  });

  it('dispatches only once for the latest matching debate-request event in a mixed batch', async () => {
    const setup = await createTestApp({});
    app = setup.app;

    const key = 'campaign:debate-request::entity:12345678';
    const firstRecord = createDebateRequestRecord({
      key,
      submissionPath: 'send_yourself',
      updatedAt: '2026-03-26T10:00:00.000Z',
    });
    const latestRecord = createDebateRequestRecord({
      key,
      submissionPath: 'request_platform',
      updatedAt: '2026-03-26T10:01:00.000Z',
    });
    const unrelatedRecord = createTestInteractiveRecord({
      interactionId: 'campaign:other',
      lessonId: 'other-lesson',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      scope: { type: 'entity', entityCui: '99999999' },
      phase: 'pending',
      value: {
        kind: 'json',
        json: { value: { note: 'ignore me' } },
      },
      updatedAt: '2026-03-26T09:59:00.000Z',
      submittedAt: '2026-03-26T09:59:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: latestRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-unrelated',
            payload: { record: unrelatedRecord },
          }),
          createTestInteractiveUpdatedEvent({
            eventId: 'event-first',
            payload: { record: firstRecord },
          }),
          createTestInteractiveUpdatedEvent({
            eventId: 'event-latest',
            payload: { record: latestRecord },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await setup.processQueuedJobs();
    expect(setup.sentEmails).toHaveLength(1);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(1);

    const records = await setup.learningProgressRepo.getRecords(setup.testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()).toHaveLength(2);
  });

  it('does not send a stale earlier event when the current record is no longer eligible', async () => {
    const setup = await createTestApp({});
    app = setup.app;

    const key = 'campaign:debate-request::entity:12345678';
    const firstRecord = createDebateRequestRecord({
      key,
      submissionPath: 'request_platform',
      updatedAt: '2026-03-26T10:00:00.000Z',
    });
    const newerRecord = createDebateRequestRecord({
      key,
      submissionPath: 'send_yourself',
      updatedAt: '2026-03-26T10:01:00.000Z',
    });

    const firstResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: firstRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-first',
            payload: { record: firstRecord },
          }),
        ],
      },
    });

    const secondResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${setup.testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: newerRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-second',
            payload: { record: newerRecord },
          }),
        ],
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);

    await setup.processQueuedJobs();

    expect(setup.sentEmails).toHaveLength(0);
    expect(setup.correspondenceRepo.snapshotThreads()).toHaveLength(0);
  });
});
