import { expect, it } from 'vitest';

import { CONTRACT_LOGICAL_ID } from './logical-notification-repo.contract.js';
import { expectOk, type PortContractCases } from '../../support/index.js';

import type { DigestBatchRepo } from '@/modules/notification-platform/core/digest/ports.js';

const NOW = new Date('2026-07-10T10:00:00.000Z');
const WINDOW = {
  windowStartUtc: new Date('2026-07-09T05:00:00.000Z'),
  windowEndUtc: new Date('2026-07-10T05:00:00.000Z'),
  dispatchAtUtc: new Date('2026-07-10T05:00:00.000Z'),
};

const createInput = (id: string) => ({
  id,
  userId: 'digest-user',
  channel: 'email' as const,
  cadence: 'daily' as const,
  window: WINDOW,
  now: NOW,
});

export const digestBatchRepoContractCases: PortContractCases<DigestBatchRepo> = ({ getPort }) => {
  it('enforces one batch per user, channel, cadence, and window', async () => {
    const repo = getPort();
    const batches = await Promise.all([
      repo.findOrCreateOpen(createInput('30000000-0000-4000-8000-000000000001')),
      repo.findOrCreateOpen(createInput('30000000-0000-4000-8000-000000000002')),
    ]);
    expect(new Set(batches.map((result) => expectOk(result).id)).size).toBe(1);
  });

  it('adds digest members idempotently', async () => {
    const repo = getPort();
    const batch = expectOk(
      await repo.findOrCreateOpen(createInput('30000000-0000-4000-8000-000000000003'))
    );
    expect(
      expectOk(
        await repo.addMemberIdempotent({
          batchId: batch.id,
          logicalNotificationId: CONTRACT_LOGICAL_ID,
          now: NOW,
        })
      )
    ).toBe('added');
    expect(
      expectOk(
        await repo.addMemberIdempotent({
          batchId: batch.id,
          logicalNotificationId: CONTRACT_LOGICAL_ID,
          now: NOW,
        })
      )
    ).toBe('duplicate');
  });

  it('claims each due batch at most once under concurrent sweepers', async () => {
    const repo = getPort();
    const batch = expectOk(
      await repo.findOrCreateOpen(createInput('30000000-0000-4000-8000-000000000004'))
    );
    const claims = await Promise.all([
      repo.claimDue({
        now: NOW,
        limit: 1,
        claimToken: '30000000-0000-4000-8000-000000000101',
        leaseSeconds: 60,
      }),
      repo.claimDue({
        now: NOW,
        limit: 1,
        claimToken: '30000000-0000-4000-8000-000000000102',
        leaseSeconds: 60,
      }),
    ]);
    expect(claims.flatMap((result) => expectOk(result)).map((row) => row.id)).toEqual([batch.id]);
  });

  it('retakes an expired materializing lease', async () => {
    const repo = getPort();
    const batch = expectOk(
      await repo.findOrCreateOpen(createInput('30000000-0000-4000-8000-000000000006'))
    );
    expectOk(
      await repo.claimDue({
        now: NOW,
        limit: 1,
        claimToken: '30000000-0000-4000-8000-000000000601',
        leaseSeconds: 60,
      })
    );
    expect(
      expectOk(
        await repo.claimDue({
          now: new Date('2026-07-10T10:00:30.000Z'),
          limit: 1,
          claimToken: '30000000-0000-4000-8000-000000000602',
          leaseSeconds: 60,
        })
      )
    ).toEqual([]);
    expect(
      expectOk(
        await repo.claimDue({
          now: new Date('2026-07-10T10:02:00.000Z'),
          limit: 1,
          claimToken: '30000000-0000-4000-8000-000000000603',
          leaseSeconds: 60,
        })
      )[0]
    ).toMatchObject({ id: batch.id, claimToken: '30000000-0000-4000-8000-000000000603' });
  });

  it('fences rendered materialization by the claim token', async () => {
    const repo = getPort();
    const batch = expectOk(
      await repo.findOrCreateOpen(createInput('30000000-0000-4000-8000-000000000005'))
    );
    const token = '30000000-0000-4000-8000-000000000201';
    expectOk(await repo.claimDue({ now: NOW, limit: 1, claimToken: token, leaseSeconds: 60 }));
    expect(
      expectOk(
        await repo.markRendered({
          batchId: batch.id,
          expectedClaimToken: '30000000-0000-4000-8000-000000000202',
          renderedItemIds: [CONTRACT_LOGICAL_ID],
          overflowCount: 0,
          deliveryId: '30000000-0000-4000-8000-000000000301',
          now: NOW,
        })
      )
    ).toBe(false);
    expect(
      expectOk(
        await repo.markRendered({
          batchId: batch.id,
          expectedClaimToken: token,
          renderedItemIds: [CONTRACT_LOGICAL_ID],
          overflowCount: 0,
          deliveryId: '30000000-0000-4000-8000-000000000301',
          now: NOW,
        })
      )
    ).toBe(true);
  });

  it('rejects new members after the batch is rendered', async () => {
    const repo = getPort();
    const batch = expectOk(
      await repo.findOrCreateOpen(createInput('30000000-0000-4000-8000-000000000007'))
    );
    const token = '30000000-0000-4000-8000-000000000701';
    expectOk(await repo.claimDue({ now: NOW, limit: 1, claimToken: token, leaseSeconds: 60 }));
    expectOk(
      await repo.markRendered({
        batchId: batch.id,
        expectedClaimToken: token,
        renderedItemIds: [CONTRACT_LOGICAL_ID],
        overflowCount: 0,
        deliveryId: '30000000-0000-4000-8000-000000000702',
        now: NOW,
      })
    );
    expect(
      expectOk(
        await repo.addMemberIdempotent({
          batchId: batch.id,
          logicalNotificationId: CONTRACT_LOGICAL_ID,
          now: NOW,
        })
      )
    ).toBe('batch_closed');
  });
};
