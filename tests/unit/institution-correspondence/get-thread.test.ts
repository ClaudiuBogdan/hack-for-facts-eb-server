import { describe, expect, it } from 'vitest';

import { getThread } from '@/modules/institution-correspondence/index.js';

import { createThreadRecord, makeInMemoryCorrespondenceRepo } from './fake-repo.js';

describe('getThread', () => {
  it('returns the requested thread', async () => {
    const thread = createThreadRecord({ id: 'thread-1' });
    const repo = makeInMemoryCorrespondenceRepo({ threads: [thread] });

    const result = await getThread({ repo }, 'thread-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe('thread-1');
    }
  });

  it('returns not found when the thread is missing', async () => {
    const repo = makeInMemoryCorrespondenceRepo();

    const result = await getThread({ repo }, 'missing-thread');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('CorrespondenceNotFoundError');
    }
  });
});
