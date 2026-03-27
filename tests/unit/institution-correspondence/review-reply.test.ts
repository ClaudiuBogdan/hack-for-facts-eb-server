import { describe, expect, it } from 'vitest';

import { reviewReply } from '@/modules/institution-correspondence/index.js';

import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

describe('reviewReply', () => {
  it('maps debate_announced replies to resolved_positive and stores thread-level review state', async () => {
    const reply = createCorrespondenceEntry({
      id: 'entry-1',
      direction: 'inbound',
      source: 'institution_reply',
    });
    const thread = createThreadRecord({
      id: 'thread-1',
      phase: 'reply_received_unreviewed',
      record: createThreadAggregateRecord({
        correspondence: [reply],
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [thread],
    });

    const result = await reviewReply(
      { repo },
      {
        threadId: 'thread-1',
        basedOnEntryId: 'entry-1',
        resolutionCode: 'debate_announced',
        reviewNotes: 'Institution announced the hearing date.',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.thread.phase).toBe('resolved_positive');
      expect(result.value.thread.closedAt).not.toBeNull();
      expect(result.value.thread.record.latestReview?.basedOnEntryId).toBe('entry-1');
      expect(result.value.thread.record.latestReview?.resolutionCode).toBe('debate_announced');
      expect(result.value.reply.id).toBe('entry-1');
    }
  });
});
