import { expect, it } from 'vitest';

import { expectOk, type PortContractCases } from '../../support/index.js';

import type { ChannelDestinationRepo } from '@/modules/notification-platform/core/delivery/ports.js';

const NOW = new Date('2026-07-10T10:00:00.000Z');

export const channelDestinationRepoContractCases: PortContractCases<ChannelDestinationRepo> = ({
  getPort,
}) => {
  it('increments generations and keeps exactly one current destination', async () => {
    const repo = getPort();
    const first = expectOk(
      await repo.ensureCurrent({
        userId: 'destination-user',
        channel: 'email',
        fingerprint: 'fingerprint-a',
        now: NOW,
      })
    );
    const same = expectOk(
      await repo.ensureCurrent({
        userId: 'destination-user',
        channel: 'email',
        fingerprint: 'fingerprint-a',
        now: NOW,
      })
    );
    const next = expectOk(
      await repo.ensureCurrent({
        userId: 'destination-user',
        channel: 'email',
        fingerprint: 'fingerprint-b',
        now: new Date('2026-07-10T10:01:00.000Z'),
      })
    );
    expect(same.id).toBe(first.id);
    expect(first.generation).toBe(1);
    expect(next.generation).toBe(2);
    expect(
      expectOk(await repo.getCurrent({ userId: 'destination-user', channel: 'email' }))
    ).toMatchObject({
      id: next.id,
      isCurrent: true,
      fingerprint: 'fingerprint-b',
    });
  });

  it('is race-safe when ensuring the same first destination', async () => {
    const repo = getPort();
    const results = await Promise.all([
      repo.ensureCurrent({
        userId: 'race-user',
        channel: 'email',
        fingerprint: 'race-fingerprint',
        now: NOW,
      }),
      repo.ensureCurrent({
        userId: 'race-user',
        channel: 'email',
        fingerprint: 'race-fingerprint',
        now: NOW,
      }),
    ]);
    expect(new Set(results.map((result) => expectOk(result).id)).size).toBe(1);
  });

  it('suppresses every matching fingerprint and reports the affected count', async () => {
    const repo = getPort();
    for (const userId of ['destination-user-a', 'destination-user-b']) {
      expectOk(
        await repo.ensureCurrent({
          userId,
          channel: 'email',
          fingerprint: 'shared-fingerprint',
          now: NOW,
        })
      );
    }
    expect(
      expectOk(
        await repo.suppressByFingerprint({
          fingerprint: 'shared-fingerprint',
          channel: 'email',
          reason: 'bounce',
          now: NOW,
        })
      )
    ).toBe(2);
    const suppressed = expectOk(await repo.listSuppressed({ cursor: null, limit: 10 }));
    expect(suppressed.items).toHaveLength(2);
    expect(suppressed.items.every((row) => row.suppressionReason === 'bounce')).toBe(true);
  });

  it('reactivates A after A to B to A with a new generation and preserved suppression', async () => {
    const repo = getPort();
    const first = expectOk(
      await repo.ensureCurrent({
        userId: 'rotation-user',
        channel: 'email',
        fingerprint: 'rotation-a',
        now: NOW,
      })
    );
    expectOk(
      await repo.suppressByFingerprint({
        fingerprint: 'rotation-a',
        channel: 'email',
        reason: 'hard_bounce',
        now: new Date('2026-07-10T10:01:00.000Z'),
      })
    );
    expectOk(
      await repo.ensureCurrent({
        userId: 'rotation-user',
        channel: 'email',
        fingerprint: 'rotation-b',
        now: new Date('2026-07-10T10:02:00.000Z'),
      })
    );
    const restored = expectOk(
      await repo.ensureCurrent({
        userId: 'rotation-user',
        channel: 'email',
        fingerprint: 'rotation-a',
        now: new Date('2026-07-10T10:03:00.000Z'),
      })
    );
    expect(restored).toMatchObject({
      id: first.id,
      generation: 3,
      isCurrent: true,
      suppressionReason: 'hard_bounce',
    });
    expect(restored.suppressedAt).not.toBeNull();
  });
};
