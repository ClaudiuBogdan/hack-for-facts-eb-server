import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { makeLearningProgressAdminReviewRoutes } from '@/modules/learning-progress/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

const LOCAL_REVIEW_API_KEY = 'local-key';

interface ReviewQueueResponseBody {
  ok: true;
  data: {
    items: LearningProgressRecordRow[];
    page: {
      offset: number;
      limit: number;
      hasMore: boolean;
    };
  };
}

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

async function fetchPendingReviewItems(baseUrl: string): Promise<LearningProgressRecordRow[]> {
  const response = await fetch(`${baseUrl}/api/v1/admin/learning-progress/reviews?status=pending`, {
    headers: {
      'x-learning-progress-review-api-key': LOCAL_REVIEW_API_KEY,
    },
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as ReviewQueueResponseBody;
  return body.data.items;
}

function buildAutomationDecisions(items: LearningProgressRecordRow[]) {
  return items.map((item) => ({
    userId: item.userId,
    recordKey: item.recordKey,
    expectedUpdatedAt: item.record.updatedAt,
    ...(item.recordKey.includes('success')
      ? {
          status: 'approved' as const,
        }
      : {
          status: 'rejected' as const,
          feedbackText: 'Automation review rejected this submission.',
        }),
  }));
}

describe('Learning Progress Review Automation Proof Of Concept', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it('fetches pending items, processes them, and sends back one success and one failure', async () => {
    const successRecord = createTestInteractiveRecord({
      key: 'automation-success::global',
      phase: 'pending',
      interactionId: 'automation-success',
      updatedAt: '2026-03-24T08:00:00.000Z',
    });
    const failureRecord = createTestInteractiveRecord({
      key: 'automation-failure::global',
      phase: 'pending',
      interactionId: 'automation-failure',
      updatedAt: '2026-03-24T08:01:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-success', [makeRow('user-success', successRecord, '1')]);
    initialRecords.set('user-failure', [makeRow('user-failure', failureRecord, '2')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    app = fastifyLib({ logger: false });
    await app.register(
      makeLearningProgressAdminReviewRoutes({
        learningProgressRepo: repo,
        apiKey: LOCAL_REVIEW_API_KEY,
      })
    );

    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    const pendingItems = await fetchPendingReviewItems(baseUrl);
    expect(pendingItems.map((item) => item.recordKey).sort()).toEqual([
      failureRecord.key,
      successRecord.key,
    ]);

    const decisionResponse = await fetch(`${baseUrl}/api/v1/admin/learning-progress/reviews`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-learning-progress-review-api-key': LOCAL_REVIEW_API_KEY,
      },
      body: JSON.stringify({
        items: buildAutomationDecisions(pendingItems),
      }),
    });

    expect(decisionResponse.status).toBe(200);

    const approvedResponse = await fetch(
      `${baseUrl}/api/v1/admin/learning-progress/reviews?status=approved`,
      {
        headers: {
          'x-learning-progress-review-api-key': LOCAL_REVIEW_API_KEY,
        },
      }
    );
    const rejectedResponse = await fetch(
      `${baseUrl}/api/v1/admin/learning-progress/reviews?status=rejected`,
      {
        headers: {
          'x-learning-progress-review-api-key': LOCAL_REVIEW_API_KEY,
        },
      }
    );

    expect(approvedResponse.status).toBe(200);
    expect(rejectedResponse.status).toBe(200);

    const approvedBody = (await approvedResponse.json()) as ReviewQueueResponseBody;
    const rejectedBody = (await rejectedResponse.json()) as ReviewQueueResponseBody;

    expect(approvedBody.data.items).toHaveLength(1);
    expect(approvedBody.data.items[0]?.recordKey).toBe(successRecord.key);
    expect(approvedBody.data.items[0]?.record.phase).toBe('resolved');
    expect(approvedBody.data.items[0]?.record.review?.status).toBe('approved');

    expect(rejectedBody.data.items).toHaveLength(1);
    expect(rejectedBody.data.items[0]?.recordKey).toBe(failureRecord.key);
    expect(rejectedBody.data.items[0]?.record.phase).toBe('failed');
    expect(rejectedBody.data.items[0]?.record.review).toEqual({
      status: 'rejected',
      reviewedAt: rejectedBody.data.items[0]?.record.updatedAt,
      feedbackText: 'Automation review rejected this submission.',
    });

    const successRow = (await repo.getRecords('user-success'))._unsafeUnwrap()[0];
    const failureRow = (await repo.getRecords('user-failure'))._unsafeUnwrap()[0];

    expect(successRow?.record.phase).toBe('resolved');
    expect(successRow?.record.review?.status).toBe('approved');
    expect(failureRow?.record.phase).toBe('failed');
    expect(failureRow?.record.review?.status).toBe('rejected');
  });
});
