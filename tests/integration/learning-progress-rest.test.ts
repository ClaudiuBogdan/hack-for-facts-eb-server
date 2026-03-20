import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';
import { makeLearningProgressRoutes } from '@/modules/learning-progress/shell/rest/routes.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  createTestProgressResetEvent,
  makeFakeLearningProgressRepo,
} from '../fixtures/fakes.js';

import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

const createTestApp = async (options: { learningProgressRepo?: LearningProgressRepository }) => {
  const { provider } = createTestAuthProvider();
  const app = fastifyLib({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const statusCode = error.statusCode ?? 500;
    void reply.status(statusCode).send({
      ok: false,
      error: error.code ?? error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
    });
  });

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: provider }));

  await app.register(
    makeLearningProgressRoutes({
      learningProgressRepo: options.learningProgressRepo ?? makeFakeLearningProgressRepo(),
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
    initialRecords.set(testAuth.userIds.user1, [
      {
        userId: testAuth.userIds.user1,
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '4',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

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
        eventId: 'server:4:quiz-1::entity:123',
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
    expect(response.json()).toEqual({ ok: true });

    const records = await repo.getRecords(testAuth.userIds.user1);
    expect(records.isOk()).toBe(true);
    expect(records._unsafeUnwrap()[0]?.record).toEqual(record);
  });

  it('accepts progress.reset and clears stored rows', async () => {
    const record = createTestInteractiveRecord({ key: 'quiz-1::global' });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [
      {
        userId: testAuth.userIds.user1,
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
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
    const body = response.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('InvalidEventError');
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
    expect(response.json()).toEqual({ ok: true });
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
      details?: unknown;
    }>();
    expect(body.error).toBe('FST_ERR_VALIDATION');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('isolates records between users', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set(testAuth.userIds.user1, [
      {
        userId: testAuth.userIds.user1,
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

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
    initialRecords.set(testAuth.userIds.user1, [
      {
        userId: testAuth.userIds.user1,
        recordKey: oldRecord.key,
        record: oldRecord,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: oldRecord.updatedAt,
        updatedAt: oldRecord.updatedAt,
      },
    ]);
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
