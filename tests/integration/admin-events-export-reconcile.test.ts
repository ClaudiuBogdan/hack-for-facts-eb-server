import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fromThrowable } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  exportAdminEventBundles,
  makeAdminEventRegistry,
  makeInstitutionCorrespondenceReplyReviewPendingEventDefinition,
  makeLocalAdminEventBundleStore,
  queueAdminEvent,
  reconcileAdminEventQueue,
  scanAndQueueAdminEvents,
} from '@/modules/admin-events/index.js';
import { reviewReply } from '@/modules/institution-correspondence/index.js';

import { makeInMemoryAdminEventQueue } from '../fixtures/index.js';
import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../unit/institution-correspondence/fake-repo.js';

const safeJsonParse = fromThrowable(JSON.parse);

describe('admin events export and reconcile workflow', () => {
  it('exports jobs non-destructively and writes the expected bundle layout', async () => {
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
      makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
        repo: correspondenceRepo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue();
    const bundleStore = makeLocalAdminEventBundleStore();

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

    expect(queue.snapshot()).toHaveLength(1);
    expect(exportResult.value.jobs).toHaveLength(1);

    const manifestPath = path.join(outputDir, 'export-bulk-1', 'manifest.json');
    const manifestResult = safeJsonParse(await readFile(manifestPath, 'utf8'));
    expect(manifestResult.isOk()).toBe(true);
    if (manifestResult.isErr()) {
      return;
    }

    const manifest = manifestResult.value as {
      jobs: { bundleDir: string }[];
    };
    expect(manifest.jobs).toHaveLength(1);

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
    const correspondenceRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-scan-1',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-scan-1',
                direction: 'inbound',
                source: 'institution_reply',
              }),
            ],
          }),
        }),
      ],
    });
    const registry = makeAdminEventRegistry([
      makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
        repo: correspondenceRepo,
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

    const reviewResult = await reviewReply(
      { repo: correspondenceRepo },
      {
        threadId: 'thread-scan-1',
        basedOnEntryId: 'reply-scan-1',
        resolutionCode: 'debate_announced',
        reviewNotes: null,
      }
    );
    expect(reviewResult.isOk()).toBe(true);

    const reconcileResult = await reconcileAdminEventQueue({ registry, queue });
    expect(reconcileResult.isOk()).toBe(true);
    if (reconcileResult.isErr()) {
      return;
    }

    expect(reconcileResult.value.removedJobIds).toHaveLength(1);
    expect(queue.snapshot()).toHaveLength(0);
  });
});
