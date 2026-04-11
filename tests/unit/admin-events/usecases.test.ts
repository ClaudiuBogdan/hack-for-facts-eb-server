import { describe, expect, it } from 'vitest';

import { buildBullmqJobId } from '@/infra/queue/job-id.js';
import {
  INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
  makeAdminEventRegistry,
  makeInstitutionCorrespondenceReplyReviewPendingEventDefinition,
  queueAdminEvent,
  scanAndQueueAdminEvents,
} from '@/modules/admin-events/index.js';

import { makeInMemoryAdminEventQueue } from '../../fixtures/index.js';
import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../institution-correspondence/fake-repo.js';

describe('admin event queue use cases', () => {
  it('validates payloads before enqueueing and uses deterministic job ids', async () => {
    const correspondenceRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-1',
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

    const correspondenceResult = await queueAdminEvent(
      { registry, queue },
      {
        eventType: INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
        payload: {
          threadId: 'thread-1',
          basedOnEntryId: 'reply-1',
        },
      }
    );

    expect(correspondenceResult.isOk()).toBe(true);
    if (correspondenceResult.isOk()) {
      expect(correspondenceResult.value.jobId).toBe(
        buildBullmqJobId('institution_correspondence.reply_review_pending', 'thread-1', 'reply-1')
      );
    }

    const invalidResult = await queueAdminEvent(
      { registry, queue },
      {
        eventType: INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
        payload: {
          threadId: 'thread-1',
        },
      }
    );

    expect(invalidResult.isErr()).toBe(true);
    if (invalidResult.isErr()) {
      expect(invalidResult.error.type).toBe('AdminEventValidationError');
    }
  });

  it('re-scans pending replies without creating duplicate jobs', async () => {
    const correspondenceRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-repeat-1',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-repeat-1',
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

    const secondScan = await scanAndQueueAdminEvents({ registry, queue });
    expect(secondScan.isOk()).toBe(true);
    expect(queue.snapshot()).toHaveLength(1);
    expect(queue.snapshot()[0]?.jobId).toBe(
      buildBullmqJobId(
        'institution_correspondence.reply_review_pending',
        'thread-repeat-1',
        'reply-repeat-1'
      )
    );
  });
});
