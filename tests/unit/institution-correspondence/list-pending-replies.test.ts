import { describe, expect, it } from 'vitest';

import { listPendingReplies } from '@/modules/institution-correspondence/index.js';

import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

describe('listPendingReplies', () => {
  it('returns reply_received_unreviewed threads with their latest inbound reply', async () => {
    const thread = createThreadRecord({
      id: 'thread-1',
      phase: 'reply_received_unreviewed',
      record: createThreadAggregateRecord({
        correspondence: [
          createCorrespondenceEntry({
            id: 'entry-old',
            occurredAt: '2026-03-25T10:00:00.000Z',
          }),
          createCorrespondenceEntry({
            id: 'entry-new',
            occurredAt: '2026-03-25T11:00:00.000Z',
          }),
        ],
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({ threads: [thread] });

    const result = await listPendingReplies({ repo }, { limit: 10, offset: 0 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.totalCount).toBe(1);
      expect(result.value.items[0]?.thread.id).toBe('thread-1');
      expect(result.value.items[0]?.reply.id).toBe('entry-new');
      expect(result.value.hasMore).toBe(false);
    }
  });
});
