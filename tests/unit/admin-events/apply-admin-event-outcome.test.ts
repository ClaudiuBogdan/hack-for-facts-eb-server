import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyAdminEventOutcome,
  exportAdminEventBundles,
  makeAdminEventRegistry,
  makeInstitutionCorrespondenceReplyReviewPendingEventDefinition,
  makeLocalAdminEventBundleStore,
  queueAdminEvent,
} from '@/modules/admin-events/index.js';

import { makeInMemoryAdminEventQueue } from '../../fixtures/index.js';
import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../institution-correspondence/fake-repo.js';

describe('applyAdminEventOutcome', () => {
  it('returns queueCleanupPending when DB apply succeeds but queue removal fails once', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-apply-1',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-apply-1',
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
        repo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue({
      failRemoveCount: 1,
    });
    const bundleStore = makeLocalAdminEventBundleStore();

    const queueResult = await queueAdminEvent(
      { registry, queue },
      {
        eventType: 'institution_correspondence.reply_review_pending',
        payload: {
          threadId: 'thread-apply-1',
          basedOnEntryId: 'reply-apply-1',
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
      `${JSON.stringify({ resolutionCode: 'debate_announced' }, null, 2)}\n`,
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
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-apply-2',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-apply-2',
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
        repo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue({
      failRemoveCount: 2,
    });
    const bundleStore = makeLocalAdminEventBundleStore();

    await queueAdminEvent(
      { registry, queue },
      {
        eventType: 'institution_correspondence.reply_review_pending',
        payload: {
          threadId: 'thread-apply-2',
          basedOnEntryId: 'reply-apply-2',
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
      `${JSON.stringify({ resolutionCode: 'debate_announced' }, null, 2)}\n`,
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
