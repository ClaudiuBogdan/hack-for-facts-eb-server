import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { makeLearningProgressAdminReviewRoutes } from '@/modules/learning-progress/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../fixtures/fakes.js';

import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

const TEST_API_KEY = 'review-api-key-12345678901234567890';

function makeRow(userId: string, record: LearningProgressRecordRow['record'], updatedSeq: string) {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  } satisfies LearningProgressRecordRow;
}

const createTestApp = async (options: {
  learningProgressRepo?: LearningProgressRepository;
  apiKey?: string;
}) => {
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

  if (options.apiKey !== undefined) {
    await app.register(
      makeLearningProgressAdminReviewRoutes({
        learningProgressRepo: options.learningProgressRepo ?? makeFakeLearningProgressRepo(),
        apiKey: options.apiKey,
      })
    );
  }

  await app.ready();
  return app;
};

describe('Learning Progress Admin Review REST API', () => {
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

  it('returns 404 when the admin review routes are not enabled', async () => {
    app = await createTestApp({});

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/learning-progress/reviews',
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 401 when the review API key header is missing', async () => {
    app = await createTestApp({ apiKey: TEST_API_KEY });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/learning-progress/reviews',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'X-Learning-Progress-Review-Api-Key header required',
      retryable: false,
    });
  });

  it('returns 401 when the review API key is invalid', async () => {
    app = await createTestApp({ apiKey: TEST_API_KEY });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/learning-progress/reviews',
      headers: {
        'x-learning-progress-review-api-key': 'wrong-key',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'Invalid API key',
      retryable: false,
    });
  });

  it('supports exact-match filters, stable ordering, and offset-limit pagination', async () => {
    const pendingUser2 = createTestInteractiveRecord({
      key: 'review-b::global',
      phase: 'pending',
      interactionId: 'review-target',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });
    const pendingUser1 = createTestInteractiveRecord({
      key: 'review-a::global',
      phase: 'pending',
      interactionId: 'review-target',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });
    const pendingOtherInteraction = createTestInteractiveRecord({
      key: 'review-c::global',
      phase: 'pending',
      interactionId: 'other-target',
      updatedAt: '2026-03-23T20:09:00.000Z',
    });
    const approved = createTestInteractiveRecord({
      key: 'approved::global',
      phase: 'resolved',
      interactionId: 'review-target',
      updatedAt: '2026-03-23T20:11:00.000Z',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T20:11:00.000Z',
      },
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-2', [makeRow('user-2', pendingUser2, '1')]);
    initialRecords.set('user-1', [
      makeRow('user-1', pendingUser1, '2'),
      makeRow('user-1', pendingOtherInteraction, '3'),
    ]);
    initialRecords.set('user-3', [makeRow('user-3', approved, '4')]);

    app = await createTestApp({
      apiKey: TEST_API_KEY,
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/learning-progress/reviews?interactionId=review-target&limit=1&offset=1',
      headers: {
        'x-learning-progress-review-api-key': TEST_API_KEY,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [expect.objectContaining({ userId: 'user-2', recordKey: pendingUser2.key })],
        page: {
          offset: 1,
          limit: 1,
          hasMore: false,
        },
      },
    });
  });

  it('supports direct raw recordKeyPrefix filtering', async () => {
    const prefixedA = createTestInteractiveRecord({
      key: 'record-prefix-001/a',
      phase: 'pending',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });
    const prefixedB = createTestInteractiveRecord({
      key: 'record-prefix-001/b',
      phase: 'pending',
      updatedAt: '2026-03-23T20:09:00.000Z',
    });
    const otherPrefix = createTestInteractiveRecord({
      key: 'record-prefixed-001/c',
      phase: 'pending',
      updatedAt: '2026-03-23T20:08:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', prefixedA, '1'),
      makeRow('user-1', prefixedB, '2'),
      makeRow('user-1', otherPrefix, '3'),
    ]);

    app = await createTestApp({
      apiKey: TEST_API_KEY,
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/learning-progress/reviews?recordKeyPrefix=record-prefix-001&limit=10&offset=0',
      headers: {
        'x-learning-progress-review-api-key': TEST_API_KEY,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({ recordKey: prefixedA.key }),
          expect.objectContaining({ recordKey: prefixedB.key }),
        ],
        page: {
          offset: 0,
          limit: 10,
          hasMore: false,
        },
      },
    });
  });

  it('keeps lessonId and interactionId as exact JSON-field filters', async () => {
    const lessonOneInteractionA = createTestInteractiveRecord({
      key: 'custom-prefix/a',
      lessonId: 'lesson-1',
      interactionId: 'interaction-a',
      phase: 'pending',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });
    const lessonOneInteractionB = createTestInteractiveRecord({
      key: 'custom-prefix/b',
      lessonId: 'lesson-1',
      interactionId: 'interaction-b',
      phase: 'pending',
      updatedAt: '2026-03-23T20:09:00.000Z',
    });
    const lessonTwoInteractionA = createTestInteractiveRecord({
      key: 'custom-prefix/c',
      lessonId: 'lesson-2',
      interactionId: 'interaction-a',
      phase: 'pending',
      updatedAt: '2026-03-23T20:08:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', lessonOneInteractionA, '1'),
      makeRow('user-1', lessonOneInteractionB, '2'),
      makeRow('user-1', lessonTwoInteractionA, '3'),
    ]);

    app = await createTestApp({
      apiKey: TEST_API_KEY,
      learningProgressRepo: makeFakeLearningProgressRepo({ initialRecords }),
    });

    const lessonResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/learning-progress/reviews?lessonId=lesson-1&limit=10&offset=0',
      headers: {
        'x-learning-progress-review-api-key': TEST_API_KEY,
      },
    });
    const lessonInteractionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/learning-progress/reviews?lessonId=lesson-1&interactionId=interaction-a&limit=10&offset=0',
      headers: {
        'x-learning-progress-review-api-key': TEST_API_KEY,
      },
    });

    expect(lessonResponse.statusCode).toBe(200);
    expect(lessonResponse.json()).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({ recordKey: lessonOneInteractionA.key }),
          expect.objectContaining({ recordKey: lessonOneInteractionB.key }),
        ],
        page: {
          offset: 0,
          limit: 10,
          hasMore: false,
        },
      },
    });

    expect(lessonInteractionResponse.statusCode).toBe(200);
    expect(lessonInteractionResponse.json()).toEqual({
      ok: true,
      data: {
        items: [expect.objectContaining({ recordKey: lessonOneInteractionA.key })],
        page: {
          offset: 0,
          limit: 10,
          hasMore: false,
        },
      },
    });
  });

  it('submits review decisions and persists sync-visible updatedAt changes', async () => {
    const record = createTestInteractiveRecord({
      key: 'review-target::global',
      phase: 'pending',
      interactionId: 'review-target',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({
      apiKey: TEST_API_KEY,
      learningProgressRepo: repo,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/learning-progress/reviews',
      headers: {
        'content-type': 'application/json',
        'x-learning-progress-review-api-key': TEST_API_KEY,
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: record.key,
            expectedUpdatedAt: record.updatedAt,
            status: 'approved',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      data: {
        items: {
          record: { phase: string; updatedAt: string; review?: { status: string } };
          auditEvents: { type: string }[];
        }[];
      };
    }>();

    expect(body.ok).toBe(true);
    expect(body.data.items[0]?.record.phase).toBe('resolved');
    expect(body.data.items[0]?.record.review?.status).toBe('approved');
    expect(body.data.items[0]?.record.updatedAt).not.toBe(record.updatedAt);
    expect(body.data.items[0]?.auditEvents.at(-1)?.type).toBe('evaluated');

    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow?.record.phase).toBe('resolved');
    expect(storedRow?.record.review?.status).toBe('approved');
    expect(storedRow?.record.updatedAt).toBe(body.data.items[0]?.record.updatedAt);
  });

  it('accepts equivalent expectedUpdatedAt timestamps serialized with different offsets', async () => {
    const record = createTestInteractiveRecord({
      key: 'review-target::global',
      phase: 'pending',
      interactionId: 'review-target',
      updatedAt: '2026-03-23T20:10:00+02:00',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({
      apiKey: TEST_API_KEY,
      learningProgressRepo: repo,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/learning-progress/reviews',
      headers: {
        'content-type': 'application/json',
        'x-learning-progress-review-api-key': TEST_API_KEY,
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: record.key,
            expectedUpdatedAt: '2026-03-23T18:10:00.000Z',
            status: 'approved',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow?.record.review?.status).toBe('approved');
  });

  it('applies bulk reviews atomically across multiple users', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'pending-review::global',
      phase: 'pending',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });
    const resolvedRecord = createTestInteractiveRecord({
      key: 'resolved-review::global',
      phase: 'resolved',
      updatedAt: '2026-03-23T20:11:00.000Z',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T20:11:00.000Z',
      },
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', pendingRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', resolvedRecord, '2')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = await createTestApp({
      apiKey: TEST_API_KEY,
      learningProgressRepo: repo,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/learning-progress/reviews',
      headers: {
        'content-type': 'application/json',
        'x-learning-progress-review-api-key': TEST_API_KEY,
      },
      payload: {
        items: [
          {
            userId: 'user-1',
            recordKey: pendingRecord.key,
            expectedUpdatedAt: pendingRecord.updatedAt,
            status: 'approved',
          },
          {
            userId: 'user-2',
            recordKey: resolvedRecord.key,
            expectedUpdatedAt: resolvedRecord.updatedAt,
            status: 'approved',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ok: false,
      error: 'ConflictError',
      message: `Interaction record "${resolvedRecord.key}" is no longer reviewable because it is not pending.`,
      retryable: false,
    });

    const user1Row = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    const user2Row = (await repo.getRecords('user-2'))._unsafeUnwrap()[0];

    expect(user1Row?.record.phase).toBe('pending');
    expect(user1Row?.record.review).toBeUndefined();
    expect(user2Row?.record.phase).toBe('resolved');
    expect(user2Row?.record.review?.status).toBe('approved');
  });
});
