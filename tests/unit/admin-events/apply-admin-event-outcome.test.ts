import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyAdminEventOutcome,
  exportAdminEventBundles,
  makeAdminEventRegistry,
  makeLearningProgressReviewPendingEventDefinition,
  makeLocalAdminEventBundleStore,
  queueAdminEvent,
} from '@/modules/admin-events/index.js';

import {
  createTestInteractiveRecord,
  makeFakeLearningProgressRepo,
  makeInMemoryAdminEventQueue,
} from '../../fixtures/index.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

const makeRow = (
  userId: string,
  record: LearningProgressRecordRow['record'],
  updatedSeq: string
): LearningProgressRecordRow => ({
  userId,
  recordKey: record.key,
  record,
  auditEvents: [],
  updatedSeq,
  createdAt: record.updatedAt,
  updatedAt: record.updatedAt,
});

describe('applyAdminEventOutcome', () => {
  it('returns queueCleanupPending when DB apply succeeds but queue removal fails once', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'apply-review::global',
      phase: 'pending',
      updatedAt: '2026-04-05T12:00:00.000Z',
    });
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeRow('user-1', pendingRecord, '1')]]]),
    });
    const registry = makeAdminEventRegistry([
      makeLearningProgressReviewPendingEventDefinition({
        learningProgressRepo: repo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue({
      failRemoveCount: 1,
    });
    const bundleStore = makeLocalAdminEventBundleStore();

    const queueResult = await queueAdminEvent(
      { registry, queue },
      {
        eventType: 'learning_progress.review_pending',
        payload: {
          userId: 'user-1',
          recordKey: pendingRecord.key,
        },
      }
    );
    expect(queueResult.isOk()).toBe(true);

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'admin-event-apply-'));
    const exportResult = await exportAdminEventBundles(
      {
        registry,
        queue,
        bundleStore,
      },
      {
        exportId: 'export-apply-1',
        outputDir,
        workspace: outputDir,
      }
    );
    expect(exportResult.isOk()).toBe(true);
    if (exportResult.isErr()) {
      return;
    }

    const bundleDir = exportResult.value.jobs[0]?.bundleDir;
    expect(bundleDir).toBeDefined();
    if (bundleDir === undefined) {
      return;
    }

    await writeFile(
      path.join(bundleDir, 'outcome.json'),
      `${JSON.stringify({ decision: 'approve' }, null, 2)}\n`,
      'utf8'
    );

    const firstApply = await applyAdminEventOutcome(
      {
        registry,
        queue,
        bundleStore,
      },
      {
        bundleDir,
      }
    );

    expect(firstApply.isOk()).toBe(true);
    if (firstApply.isErr()) {
      return;
    }

    expect(firstApply.value.status).toBe('applied');
    expect(firstApply.value.queueCleanupPending).toBe(true);
    expect(queue.snapshot()).toHaveLength(1);

    const secondApply = await applyAdminEventOutcome(
      {
        registry,
        queue,
        bundleStore,
      },
      {
        bundleDir,
      }
    );

    expect(secondApply.isOk()).toBe(true);
    if (secondApply.isErr()) {
      return;
    }

    expect(secondApply.value.status).toBe('already_applied');
    expect(secondApply.value.queueCleanupPending).toBe(false);
    expect(secondApply.value.queueJobRemoved).toBe(true);
    expect(queue.snapshot()).toHaveLength(0);
  });

  it('returns ok(already_applied) when queue cleanup still fails after the canonical write is already done', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'apply-review-already::global',
      phase: 'pending',
      updatedAt: '2026-04-05T12:30:00.000Z',
    });
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeRow('user-1', pendingRecord, '1')]]]),
    });
    const registry = makeAdminEventRegistry([
      makeLearningProgressReviewPendingEventDefinition({
        learningProgressRepo: repo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue({
      failRemoveCount: 2,
    });
    const bundleStore = makeLocalAdminEventBundleStore();

    await queueAdminEvent(
      { registry, queue },
      {
        eventType: 'learning_progress.review_pending',
        payload: {
          userId: 'user-1',
          recordKey: pendingRecord.key,
        },
      }
    );

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'admin-event-apply-'));
    const exportResult = await exportAdminEventBundles(
      {
        registry,
        queue,
        bundleStore,
      },
      {
        exportId: 'export-apply-2',
        outputDir,
        workspace: outputDir,
      }
    );
    expect(exportResult.isOk()).toBe(true);
    if (exportResult.isErr()) {
      return;
    }

    const bundleDir = exportResult.value.jobs[0]?.bundleDir;
    expect(bundleDir).toBeDefined();
    if (bundleDir === undefined) {
      return;
    }

    await writeFile(
      path.join(bundleDir, 'outcome.json'),
      `${JSON.stringify({ decision: 'approve' }, null, 2)}\n`,
      'utf8'
    );

    const firstApply = await applyAdminEventOutcome(
      {
        registry,
        queue,
        bundleStore,
      },
      {
        bundleDir,
      }
    );
    expect(firstApply.isOk()).toBe(true);
    if (firstApply.isErr()) {
      return;
    }

    expect(firstApply.value.status).toBe('applied');
    expect(firstApply.value.queueCleanupPending).toBe(true);

    const secondApply = await applyAdminEventOutcome(
      {
        registry,
        queue,
        bundleStore,
      },
      {
        bundleDir,
      }
    );
    expect(secondApply.isOk()).toBe(true);
    if (secondApply.isErr()) {
      return;
    }

    expect(secondApply.value.status).toBe('already_applied');
    expect(secondApply.value.queueCleanupPending).toBe(true);
    expect(secondApply.value.queueJobRemoved).toBe(false);
    expect(queue.snapshot()).toHaveLength(1);
  });
});
