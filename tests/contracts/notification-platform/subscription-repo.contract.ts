import { expect, it } from 'vitest';

import { expectOk, type PortContractCases } from '../../support/index.js';

import type { SubscriptionRepo } from '@/modules/notification-platform/core/subscriptions/ports.js';

const NOW = new Date('2026-07-10T10:00:00.000Z');

const subscriptionInput = (id: string, normalizedKey: string, subjectId = 'subject-1') => ({
  id,
  userId: 'subscription-user',
  kindId: 'contract.kind',
  subjectType: 'entity',
  subjectId,
  config: { cadence: 'daily' },
  normalizedKey,
  now: NOW,
});

export const subscriptionRepoContractCases: PortContractCases<SubscriptionRepo> = ({ getPort }) => {
  it('creates or reactivates one row safely under races', async () => {
    const repo = getPort();
    const rows = await Promise.all([
      repo.createOrReactivate(
        subscriptionInput('40000000-0000-4000-8000-000000000001', 'normalized-1')
      ),
      repo.createOrReactivate(
        subscriptionInput('40000000-0000-4000-8000-000000000002', 'normalized-1')
      ),
    ]);
    expect(new Set(rows.map((result) => expectOk(result).id)).size).toBe(1);
    const active = expectOk(
      await repo.listActiveByKindAndSubject({
        kindId: 'contract.kind',
        subjectType: 'entity',
        subjectId: 'subject-1',
        afterId: null,
        limit: 10,
      })
    );
    expect(active).toHaveLength(1);

    expectOk(
      await repo.setState({
        id: active[0]?.id ?? '',
        userId: 'subscription-user',
        state: 'removed',
        now: NOW,
      })
    );
    expect(
      expectOk(
        await repo.createOrReactivate(
          subscriptionInput('40000000-0000-4000-8000-000000000003', 'normalized-1')
        )
      ).state
    ).toBe('active');
  });

  it('fans out with an id keyset cursor', async () => {
    const repo = getPort();
    for (const suffix of [11, 12, 13]) {
      expectOk(
        await repo.createOrReactivate(
          subscriptionInput(
            `40000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`,
            `normalized-${String(suffix)}`,
            'shared-subject'
          )
        )
      );
    }
    const first = expectOk(
      await repo.listActiveByKindAndSubject({
        kindId: 'contract.kind',
        subjectType: 'entity',
        subjectId: 'shared-subject',
        afterId: null,
        limit: 2,
      })
    );
    const second = expectOk(
      await repo.listActiveByKindAndSubject({
        kindId: 'contract.kind',
        subjectType: 'entity',
        subjectId: 'shared-subject',
        afterId: first.at(-1)?.id ?? null,
        limit: 2,
      })
    );
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3);
  });
};
