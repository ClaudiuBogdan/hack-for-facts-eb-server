import { describe, expect, it } from 'vitest';

import {
  createCorrespondenceEntry,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

describe('makeInMemoryCorrespondenceRepo appendCorrespondenceEntry', () => {
  it('treats explicit null timestamp fields as clears, matching the production repo', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-null-clear',
          lastEmailAt: new Date('2026-03-25T12:00:00.000Z'),
          lastReplyAt: new Date('2026-03-25T12:05:00.000Z'),
          nextActionAt: new Date('2026-03-25T12:10:00.000Z'),
          closedAt: new Date('2026-03-25T12:15:00.000Z'),
        }),
      ],
    });

    const result = await repo.appendCorrespondenceEntry({
      threadId: 'thread-null-clear',
      entry: createCorrespondenceEntry({
        id: 'entry-null-clear',
        resendEmailId: 'email-null-clear',
      }),
      lastEmailAt: null,
      lastReplyAt: null,
      nextActionAt: null,
      closedAt: null,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.lastEmailAt).toBeNull();
      expect(result.value.lastReplyAt).toBeNull();
      expect(result.value.nextActionAt).toBeNull();
      expect(result.value.closedAt).toBeNull();
    }
  });
});
