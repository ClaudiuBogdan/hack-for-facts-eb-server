import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANONYMOUS_SESSION,
  createTestAuthProvider,
  makeAuthMiddleware,
} from '@/modules/auth/index.js';
import { makeLearningProgressRoutes } from '@/modules/learning-progress/shell/rest/routes.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  createTestProgressResetEvent,
  makeFakeLearningProgressRepo,
} from '../fixtures/fakes.js';

import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
import type {
  LearningProgressEvent,
  LearningProgressRecordRow,
} from '@/modules/learning-progress/core/types.js';

function makeRow(
  userId: string,
  record: LearningProgressRecordRow['record'],
  updatedSeq: string
): LearningProgressRecordRow {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  };
}

function createStoredSourceUrlRecord(): LearningProgressRecordRow['record'] {
  return {
    key: 'custom-submit::global',
    interactionId: 'custom-submit',
    lessonId: 'lesson-source-url',
    kind: 'custom',
    scope: { type: 'global' },
    completionRule: { type: 'resolved' },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          websiteUrl: 'https://example.com',
        },
      },
    },
    result: null,
    sourceUrl: 'https://transparenta.eu/ro/learning/path/module/lesson-1?section=submit',
    updatedAt: '2024-01-15T12:00:00.000Z',
    submittedAt: '2024-01-15T12:00:00.000Z',
  };
}

function stripSourceUrl(
  record: LearningProgressRecordRow['record']
): LearningProgressRecordRow['record'] {
  const { sourceUrl, ...legacyRecord } = record;
  void sourceUrl;
  return legacyRecord;
}

const createTestApp = async (options: {
  learningProgressRepo?: LearningProgressRepository;
  onSyncEventsApplied?: (input: {
    userId: string;
    events: readonly LearningProgressEvent[];
  }) => Promise<void>;
}) => {
  const { provider } = createTestAuthProvider();
  const app = fastifyLib({ logger: false });
  const authMiddleware = makeAuthMiddleware({ authProvider: provider });

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

  app.addHook('preHandler', async (request, reply) => {
    await (authMiddleware as (req: typeof request, rep: typeof reply) => Promise<void>)(
      request,
      reply
    );

    request.auth ??= ANONYMOUS_SESSION;
  });

  await app.register(
    makeLearningProgressRoutes({
      learningProgressRepo: options.learningProgressRepo ?? makeFakeLearningProgressRepo(),
      ...(options.onSyncEventsApplied !== undefined
        ? { onSyncEventsApplied: options.onSyncEventsApplied }
        : {}),
    })
  );

  await app.ready();
  return app;
};

describe('Learning Progress REST API', () => {
  let app: FastifyInstance;
  let testAuth: ReturnType<typeof createTestAuthProvider>;

  beforeAll(() => {
    testAuth = createTestAuthProvider();
  });

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

  it('requires authentication', async () => {
    app = await createTestApp({});

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns an empty generic snapshot on cold load', async () => {
    app = await createTestApp({});

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        snapshot: {
          version: 1,
          recordsByKey: {},
          lastUpdated: null,
        },
        events: [],
        cursor: '0',
      },
    });
  });

  it('returns row deltas when a since cursor is provided', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::entity:123',
      updatedAt: '2024-01-15T11:00:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [makeRow(testAuth.userIds.user1, record, '4')]);

    app = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress?since=3',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      data: {
        snapshot: { recordsByKey: Record<string, unknown> };
        events: { type: string; payload: { record: { key: string } } }[];
        cursor: string;
      };
    }>();

    expect(body.ok).toBe(true);
    expect(body.data.snapshot.recordsByKey[record.key]).toBeDefined();
    expect(body.data.events).toEqual([
      {
        eventId: `server:4:${record.key}`,
        occurredAt: '2024-01-15T11:00:00.000Z',
        clientId: 'server',
        type: 'interactive.updated',
        payload: {
          record,
        },
      },
    ]);
    expect(body.data.cursor).toBe('4');
  });

  it('syncs interactive.updated events', async () => {
    const repo = makeFakeLearningProgressRepo();
    app = await createTestApp({ learningProgressRepo: repo });

    const record = createTestInteractiveRecord({
      key: 'system:learning-onboarding',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: { value: { step: 'done' } },
      },
      result: {
        outcome: null,
        evaluatedAt: '2024-01-15T12:00:00.000Z',
      },
      updatedAt: '2024-01-15T12:00:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2024-01-15T12:00:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-1',
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

    const records = await repo.getRecords(testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()[0]?.record).toEqual(record);
  });

  it('returns 200 when user-event queue publishing fails after sync', async () => {
    const repo = makeFakeLearningProgressRepo();
    app = await createTestApp({
      learningProgressRepo: repo,
      onSyncEventsApplied: async () => {
        throw new Error('queue unavailable');
      },
    });

    const record = createTestInteractiveRecord({
      key: 'system:learning-onboarding',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: { value: { step: 'done' } },
      },
      result: {
        outcome: null,
        evaluatedAt: '2024-01-15T12:00:00.000Z',
      },
      updatedAt: '2024-01-15T12:00:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2024-01-15T12:00:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-queue-failure',
            payload: { record },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        newEventsCount: 1,
        failedEvents: [],
      },
    });

    const records = await repo.getRecords(testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()).toHaveLength(1);
  });

  it('hands only applied events to the post-sync hook', async () => {
    const newerRecord = createTestInteractiveRecord({
      key: 'quiz-1::global',
      phase: 'resolved',
      updatedAt: '2024-01-15T10:05:00.000Z',
      result: {
        outcome: 'correct',
        evaluatedAt: '2024-01-15T10:05:00.000Z',
      },
    });
    const staleRecord = createTestInteractiveRecord({
      key: newerRecord.key,
      interactionId: newerRecord.interactionId,
      lessonId: newerRecord.lessonId,
      phase: 'draft',
      updatedAt: '2024-01-15T10:00:00.000Z',
      result: null,
    });
    const appliedRecord = createTestInteractiveRecord({
      key: 'quiz-2::global',
      interactionId: 'quiz-2',
      lessonId: 'lesson-2',
      updatedAt: '2024-01-15T10:06:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [makeRow(testAuth.userIds.user1, newerRecord, '3')]);
    let capturedHookInput:
      | {
          userId: string;
          events: readonly LearningProgressEvent[];
        }
      | undefined;
    const onSyncEventsApplied = vi.fn(
      async (input: { userId: string; events: readonly LearningProgressEvent[] }) => {
        capturedHookInput = input;
      }
    );
    app = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
      onSyncEventsApplied,
    });
    const staleEvent = createTestInteractiveUpdatedEvent({
      eventId: 'stale-event',
      occurredAt: staleRecord.updatedAt,
      payload: { record: staleRecord },
    });
    const appliedEvent = createTestInteractiveUpdatedEvent({
      eventId: 'applied-event',
      occurredAt: appliedRecord.updatedAt,
      payload: { record: appliedRecord },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: appliedRecord.updatedAt,
        events: [staleEvent, appliedEvent],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(onSyncEventsApplied).toHaveBeenCalledTimes(1);
    expect(capturedHookInput).toBeDefined();
    if (capturedHookInput !== undefined) {
      expect(capturedHookInput).toEqual({
        userId: testAuth.userIds.user1,
        events: expect.arrayContaining([
          expect.objectContaining({
            eventId: 'applied-event',
          }),
        ]),
      });
      expect(capturedHookInput.events).toHaveLength(1);
    }
  });

  it('rejects client-authored record.review for unreviewed rows', async () => {
    const repo = makeFakeLearningProgressRepo();
    app = await createTestApp({ learningProgressRepo: repo });

    const record = createTestInteractiveRecord({
      key: 'campaign:primarie-website-url::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Not allowed from client.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2026-03-23T19:30:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-review',
            payload: { record },
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
            eventId: 'event-review',
            errorType: 'InvalidEventError',
            message: 'Public progress sync cannot set record.review.',
          },
        ],
      },
    });
  });

  it('accepts exact round-trips of reviewed records returned by GET', async () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'campaign:primarie-website-url::entity:4305857',
      interactionId: 'campaign:primarie-website-url',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://reviewed.example.com',
          },
        },
      },
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [
      makeRow(testAuth.userIds.user1, reviewedRecord, '1'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({ learningProgressRepo: repo });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(getResponse.statusCode).toBe(200);
    const roundTrippedRecord = getResponse.json<{
      data: { snapshot: { recordsByKey: Record<string, LearningProgressRecordRow['record']> } };
    }>().data.snapshot.recordsByKey[reviewedRecord.key];
    expect(roundTrippedRecord).toBeDefined();
    if (roundTrippedRecord === undefined) {
      throw new Error('Expected reviewed record to be present in snapshot.');
    }
    expect(roundTrippedRecord).toEqual(reviewedRecord);

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: reviewedRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-roundtrip',
            occurredAt: reviewedRecord.updatedAt,
            payload: {
              record: roundTrippedRecord,
            },
          }),
        ],
      },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual(
      expect.objectContaining({
        ok: true,
        data: {
          newEventsCount: 0,
          failedEvents: [],
        },
      })
    );

    const storedRecord = (await repo.getRecords(testAuth.userIds.user1))._unsafeUnwrap()[0];
    expect(storedRecord?.record).toEqual(reviewedRecord);
  });

  it('does not bump cursor for legacy round-trips that omit sourceUrl', async () => {
    const storedRecord = createStoredSourceUrlRecord();
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [
      makeRow(testAuth.userIds.user1, storedRecord, '1'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({ learningProgressRepo: repo });

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: storedRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-source-url-legacy-roundtrip',
            occurredAt: storedRecord.updatedAt,
            payload: {
              record: stripSourceUrl(storedRecord),
            },
          }),
        ],
      },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual(
      expect.objectContaining({
        ok: true,
        data: {
          newEventsCount: 0,
          failedEvents: [],
        },
      })
    );

    const records = await repo.getRecords(testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()[0]).toEqual(
      expect.objectContaining({
        updatedSeq: '1',
        record: storedRecord,
      })
    );

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress?since=1',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual({
      ok: true,
      data: {
        snapshot: {
          version: 1,
          recordsByKey: {
            [storedRecord.key]: storedRecord,
          },
          lastUpdated: storedRecord.updatedAt,
        },
        events: [],
        cursor: '1',
      },
    });
  });

  it('rejects attempts to modify stored record.review', async () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'campaign:primarie-website-url::entity:4305857',
      interactionId: 'campaign:primarie-website-url',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });
    const modifiedReviewRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: reviewedRecord.phase,
      value: reviewedRecord.value,
      result: reviewedRecord.result,
      review: {
        status: 'approved',
        reviewedAt: reviewedRecord.review?.reviewedAt ?? null,
        feedbackText: 'Client changed this feedback.',
      },
      updatedAt: reviewedRecord.updatedAt,
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [
      makeRow(testAuth.userIds.user1, reviewedRecord, '1'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({ learningProgressRepo: repo });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: reviewedRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-modified-review',
            payload: { record: modifiedReviewRecord },
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
            eventId: 'event-modified-review',
            errorType: 'InvalidEventError',
            message: 'Public progress sync cannot set record.review.',
          },
        ],
      },
    });
  });

  it('preserves stored review metadata on ordinary public updates after review', async () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'campaign:primarie-website-url::entity:4305857',
      interactionId: 'campaign:primarie-website-url',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://old.example.com',
          },
        },
      },
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const updatedRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: reviewedRecord.phase,
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://new.example.com',
          },
        },
      },
      result: reviewedRecord.result,
      updatedAt: '2026-03-23T19:45:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [
      makeRow(testAuth.userIds.user1, reviewedRecord, '1'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({ learningProgressRepo: repo });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2026-03-23T19:45:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-resubmit',
            payload: { record: updatedRecord },
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

    const storedRecord = (await repo.getRecords(testAuth.userIds.user1))._unsafeUnwrap()[0];
    expect(storedRecord?.record.value).toEqual(updatedRecord.value);
    expect(storedRecord?.record.updatedAt).toBe(updatedRecord.updatedAt);
    expect(storedRecord?.record.review).toEqual(reviewedRecord.review);

    const reviewQueueResult = await repo.listReviewRows({
      status: 'approved',
      limit: 10,
      offset: 0,
    });
    expect(reviewQueueResult.isOk()).toBe(true);
    expect(reviewQueueResult._unsafeUnwrap().rows).toEqual([
      expect.objectContaining({ recordKey: reviewedRecord.key }),
    ]);
  });

  it('clears stored review metadata on newer public retries back to pending', async () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'campaign:primarie-website-url::entity:4305857',
      interactionId: 'campaign:primarie-website-url',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://old.example.com',
          },
        },
      },
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const retriedRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: 'pending',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://new.example.com',
          },
        },
      },
      result: reviewedRecord.result,
      updatedAt: '2026-03-23T19:45:00.000Z',
      submittedAt: '2026-03-23T19:45:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [
      makeRow(testAuth.userIds.user1, reviewedRecord, '1'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({ learningProgressRepo: repo });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2026-03-23T19:45:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-retry',
            payload: { record: retriedRecord },
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

    const storedRecord = (await repo.getRecords(testAuth.userIds.user1))._unsafeUnwrap()[0];
    expect(storedRecord?.record.value).toEqual(retriedRecord.value);
    expect(storedRecord?.record.updatedAt).toBe(retriedRecord.updatedAt);
    expect(storedRecord?.record.review).toBeUndefined();
  });

  it('accepts progress.reset and clears stored rows', async () => {
    const record = createTestInteractiveRecord({ key: 'quiz-1::global' });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [makeRow(testAuth.userIds.user1, record, '1')]);
    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({ learningProgressRepo: repo });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2024-01-15T12:30:00.000Z',
        events: [createTestProgressResetEvent({ eventId: 'reset-1' })],
      },
    });

    expect(response.statusCode).toBe(200);

    const records = await repo.getRecords(testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()).toEqual([]);
  });

  it('returns 400 for non-numeric since cursor', async () => {
    app = await createTestApp({});

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress?since=abc',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ ok: boolean; error: string; retryable: boolean }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('InvalidEventError');
    expect(body.retryable).toBe(false);
  });

  it('accepts empty events array on PUT', async () => {
    app = await createTestApp({});

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2024-01-15T12:00:00.000Z',
        events: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        data: {
          newEventsCount: 0,
          failedEvents: [],
        },
      })
    );
  });

  it('returns a serializable 400 error for invalid PUT payloads', async () => {
    app = await createTestApp({});

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2024-01-15T12:00:00.000Z',
        events: [
          {
            eventId: 'event-1',
            occurredAt: '2024-01-15T12:00:00.000Z',
            clientId: 'client-1',
            type: 'interactive.updated',
            payload: {
              record: {
                key: 'quiz-1::entity',
                interactionId: 'quiz-1',
                lessonId: 'lesson-1',
                kind: 'quiz',
                scope: {
                  type: 'entity',
                },
                completionRule: {
                  type: 'outcome',
                  outcome: 'correct',
                },
                phase: 'resolved',
                value: {
                  kind: 'choice',
                  choice: { selectedId: 'a' },
                },
                result: {
                  outcome: 'incorrect',
                },
                updatedAt: '2024-01-15T12:00:00.000Z',
              },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{
      ok?: false;
      error: string;
      message: string;
      retryable: boolean;
      details?: unknown;
    }>();
    expect(body.error).toBe('FST_ERR_VALIDATION');
    expect(body.retryable).toBe(false);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('isolates records between users', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [makeRow(testAuth.userIds.user1, record, '1')]);

    app = await createTestApp({
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user2}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: { snapshot: { recordsByKey: Record<string, unknown> }; events: unknown[] };
    }>();
    expect(body.data.snapshot.recordsByKey).toEqual({});
    expect(body.data.events).toEqual([]);
  });

  it('processes reset followed by interactive.updated in single batch', async () => {
    const oldRecord = createTestInteractiveRecord({
      key: 'quiz-old::global',
      updatedAt: '2024-01-15T09:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [makeRow(testAuth.userIds.user1, oldRecord, '1')]);
    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({ learningProgressRepo: repo });

    const newRecord = createTestInteractiveRecord({
      key: 'quiz-new::global',
      interactionId: 'quiz-new',
      lessonId: 'lesson-new',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2024-01-15T10:00:00.000Z',
        events: [
          createTestProgressResetEvent({ eventId: 'reset-1' }),
          createTestInteractiveUpdatedEvent({
            eventId: 'event-2',
            payload: { record: newRecord },
          }),
        ],
      },
    });

    expect(putResponse.statusCode).toBe(200);

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(getResponse.statusCode).toBe(200);
    const body = getResponse.json<{
      data: {
        snapshot: { recordsByKey: Record<string, unknown> };
      };
    }>();
    expect(body.data.snapshot.recordsByKey[newRecord.key]).toBeDefined();
    expect(body.data.snapshot.recordsByKey[oldRecord.key]).toBeUndefined();
  });

  it('rejects old content.progressed payloads', async () => {
    app = await createTestApp({});

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/learning/progress',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        clientUpdatedAt: '2024-01-15T12:30:00.000Z',
        events: [
          {
            eventId: 'old-1',
            occurredAt: '2024-01-15T12:30:00.000Z',
            clientId: 'device-1',
            type: 'content.progressed',
            payload: {
              contentId: 'lesson-1',
              status: 'completed',
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
