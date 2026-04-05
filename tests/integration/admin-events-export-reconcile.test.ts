import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fromThrowable } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  exportAdminEventBundles,
  makeAdminEventRegistry,
  makeInstitutionCorrespondenceReplyReviewPendingEventDefinition,
  makeLearningProgressReviewPendingEventDefinition,
  makeLocalAdminEventBundleStore,
  queueAdminEvent,
  reconcileAdminEventQueue,
  scanAndQueueAdminEvents,
} from '@/modules/admin-events/index.js';
import {
  updateInteractionReview,
  type LearningProgressRecordRow,
} from '@/modules/learning-progress/index.js';

import {
  createTestInteractiveRecord,
  makeFakeLearningProgressRepo,
  makeInMemoryAdminEventQueue,
} from '../fixtures/index.js';
import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../unit/institution-correspondence/fake-repo.js';

const safeJsonParse = fromThrowable(JSON.parse);

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

describe('admin events export and reconcile workflow', () => {
  it('exports jobs non-destructively and writes the expected bundle layout', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'export-review::global',
      phase: 'pending',
      updatedAt: '2026-04-05T13:00:00.000Z',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeRow('user-1', pendingRecord, '1')]]]),
    });
    const reply = createCorrespondenceEntry({
      id: 'reply-export-1',
      direction: 'inbound',
      source: 'institution_reply',
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-export-1',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            correspondence: [reply],
          }),
        }),
      ],
    });
    const registry = makeAdminEventRegistry([
      makeLearningProgressReviewPendingEventDefinition({
        learningProgressRepo,
      }),
      makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
        repo: correspondenceRepo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue();
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
    await queueAdminEvent(
      { registry, queue },
      {
        eventType: 'institution_correspondence.reply_review_pending',
        payload: {
          threadId: 'thread-export-1',
          basedOnEntryId: 'reply-export-1',
        },
      }
    );

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'admin-event-export-'));
    const exportResult = await exportAdminEventBundles(
      {
        registry,
        queue,
        bundleStore,
      },
      {
        exportId: 'export-bulk-1',
        outputDir,
        workspace: outputDir,
      }
    );

    expect(exportResult.isOk()).toBe(true);
    if (exportResult.isErr()) {
      return;
    }

    expect(queue.snapshot()).toHaveLength(2);
    expect(exportResult.value.jobs).toHaveLength(2);

    const manifestPath = path.join(outputDir, 'export-bulk-1', 'manifest.json');
    const manifestResult = safeJsonParse(await readFile(manifestPath, 'utf8'));
    expect(manifestResult.isOk()).toBe(true);
    if (manifestResult.isErr()) {
      return;
    }

    const manifest = manifestResult.value as {
      jobs: { bundleDir: string }[];
    };
    expect(manifest.jobs).toHaveLength(2);

    for (const job of manifest.jobs) {
      const inputResult = safeJsonParse(
        await readFile(path.join(job.bundleDir, 'input.json'), 'utf8')
      );
      expect(inputResult.isOk()).toBe(true);
      if (inputResult.isErr()) {
        return;
      }

      const inputJson = inputResult.value as {
        outcomeSchema: Record<string, unknown>;
      };
      const outcomeResult = safeJsonParse(
        await readFile(path.join(job.bundleDir, 'outcome.json'), 'utf8')
      );
      expect(outcomeResult.isOk()).toBe(true);
      if (outcomeResult.isErr()) {
        return;
      }

      const outcomeJson = outcomeResult.value as unknown;
      expect(inputJson.outcomeSchema).toBeDefined();
      expect(outcomeJson).toEqual({});
    }
  });

  it('recreates missing jobs on rescan and removes resolved jobs on reconcile', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'scan-review::global',
      phase: 'pending',
      updatedAt: '2026-04-05T13:30:00.000Z',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeRow('user-1', pendingRecord, '1')]]]),
    });
    const registry = makeAdminEventRegistry([
      makeLearningProgressReviewPendingEventDefinition({
        learningProgressRepo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue();

    const firstScan = await scanAndQueueAdminEvents({ registry, queue });
    expect(firstScan.isOk()).toBe(true);
    expect(queue.snapshot()).toHaveLength(1);

    const jobId = queue.snapshot()[0]?.jobId;
    expect(jobId).toBeDefined();
    if (jobId === undefined) {
      return;
    }

    queue.deleteJob(jobId);
    expect(queue.snapshot()).toHaveLength(0);

    const secondScan = await scanAndQueueAdminEvents({ registry, queue });
    expect(secondScan.isOk()).toBe(true);
    expect(queue.snapshot()).toHaveLength(1);

    const currentRow = await learningProgressRepo.getRecord('user-1', pendingRecord.key);
    expect(currentRow.isOk()).toBe(true);
    if (currentRow.isErr() || currentRow.value === null) {
      return;
    }

    const approveResult = await updateInteractionReview(
      { repo: learningProgressRepo },
      {
        userId: 'user-1',
        recordKey: pendingRecord.key,
        expectedUpdatedAt: currentRow.value.updatedAt,
        status: 'approved',
      }
    );
    expect(approveResult.isOk()).toBe(true);

    const reconcileResult = await reconcileAdminEventQueue({ registry, queue });
    expect(reconcileResult.isOk()).toBe(true);
    if (reconcileResult.isErr()) {
      return;
    }

    expect(reconcileResult.value.removedJobIds).toHaveLength(1);
    expect(queue.snapshot()).toHaveLength(0);
  });
});
