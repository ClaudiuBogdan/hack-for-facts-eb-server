import { describe, expect, it } from 'vitest';

import { assignToDigest } from '@/modules/notification-platform/core/digest/usecases/assign-to-digest.js';

import { makeUsecaseHarness } from './harness.js';
import { makeDigestBatch } from '../../../fixtures/notification-platform/index.js';
import { expectOk } from '../../../support/index.js';

describe('assignToDigest', () => {
  it('reuses the window batch and deduplicates membership', async () => {
    const h = makeUsecaseHarness();
    const input = {
      logicalNotificationId: 'logical-1',
      userId: 'user-1',
      channel: 'email' as const,
      cadence: 'daily' as const,
    };
    const first = expectOk(await assignToDigest(h, input));
    const replay = expectOk(await assignToDigest(h, input));
    expect(first.membership).toBe('added');
    expect(replay).toEqual({ batchId: first.batchId, membership: 'duplicate' });
    expect(h.digests.store.size()).toBe(1);
  });

  it('recomputes the window and retries once when membership is rejected', async () => {
    const h = makeUsecaseHarness();
    const current = expectOk(
      await h.digests.findOrCreateOpen({
        id: 'batch-old',
        userId: 'user-1',
        channel: 'email',
        cadence: 'daily',
        window: {
          windowStartUtc: new Date('2026-01-15T06:00:00.000Z'),
          windowEndUtc: new Date('2026-01-16T06:00:00.000Z'),
          dispatchAtUtc: new Date('2026-01-16T06:00:00.000Z'),
        },
        now: h.clock.now(),
      })
    );
    h.digests.store.put(makeDigestBatch(h, { ...current, status: 'rendered' }));
    const originalAdd = h.digests.addMemberIdempotent.bind(h.digests);
    let calls = 0;
    const digests = {
      ...h.digests,
      addMemberIdempotent: async (input: Parameters<typeof h.digests.addMemberIdempotent>[0]) => {
        const result = await originalAdd(input);
        calls += 1;
        if (calls === 1) {
          h.clock.advance(24 * 60 * 60 * 1000);
        }
        return result;
      },
    };

    const assigned = expectOk(
      await assignToDigest(
        { ...h, digests },
        {
          logicalNotificationId: 'logical-1',
          userId: 'user-1',
          channel: 'email',
          cadence: 'daily',
        }
      )
    );
    expect(assigned.membership).toBe('added');
    expect(assigned.batchId).not.toBe('batch-old');
    expect(calls).toBe(2);
  });
});
