import { expect, it } from 'vitest';

import { CONTRACT_EVENT_ID } from './event-repo.contract.js';
import { expectOk, type PortContractCases } from '../../support/index.js';

import type { LogicalNotificationRepo } from '@/modules/notification-platform/core/inbox/ports.js';
import type { CreateLogicalNotificationInput } from '@/modules/notification-platform/core/inbox/types.js';

export const CONTRACT_LOGICAL_ID = '20000000-0000-4000-8000-000000000001';

const logicalInput = (
  id: string,
  kindId: string,
  createdAt: Date,
  userId = 'logical-user'
): CreateLogicalNotificationInput => ({
  id,
  eventId: CONTRACT_EVENT_ID,
  kindId,
  kindVersion: 1,
  userId,
  eligibilityReason: 'eligible',
  locale: 'ro',
  recipientFacts: null,
  inboxTemplateId: 'inbox-template',
  inboxTemplateVersion: 'v1',
  inboxTitle: kindId,
  inboxBody: 'body',
  inboxActionUrl: null,
  inboxVisible: true,
  streamKey: null,
  streamSequence: null,
  createdAt,
  retentionExpiresAt: new Date('2028-07-10T10:00:00.000Z'),
});

export const logicalNotificationRepoContractCases: PortContractCases<LogicalNotificationRepo> = ({
  getPort,
}) => {
  it('inserts batches idempotently on event, kind, and user', async () => {
    const repo = getPort();
    const rows = [
      logicalInput(CONTRACT_LOGICAL_ID, 'kind-a', new Date('2026-07-10T10:00:00.000Z')),
      logicalInput(
        '20000000-0000-4000-8000-000000000002',
        'kind-b',
        new Date('2026-07-10T10:01:00.000Z')
      ),
    ];
    expect(expectOk(await repo.insertBatchIdempotent(rows))).toEqual({
      createdIds: rows.map((row) => row.id),
      duplicateCount: 0,
    });
    const replay = expectOk(await repo.insertBatchIdempotent(rows));
    expect(replay.createdIds).toEqual([]);
    expect(replay.duplicateCount).toBe(2);
  });

  it('keeps descending keyset pagination stable under interleaved inserts', async () => {
    const repo = getPort();
    await repo.insertBatchIdempotent([
      logicalInput(
        '20000000-0000-4000-8000-000000000011',
        'kind-old',
        new Date('2026-07-10T10:00:00.000Z')
      ),
      logicalInput(
        '20000000-0000-4000-8000-000000000012',
        'kind-middle',
        new Date('2026-07-10T10:01:00.000Z')
      ),
      logicalInput(
        '20000000-0000-4000-8000-000000000013',
        'kind-new',
        new Date('2026-07-10T10:02:00.000Z')
      ),
    ]);

    const first = expectOk(
      await repo.listForUser({ userId: 'logical-user', view: 'all', cursor: null, limit: 2 })
    );
    expect(first.items.map((item) => item.kindId)).toEqual(['kind-new', 'kind-middle']);
    expect(first.nextCursor).not.toBeNull();

    expectOk(
      await repo.insertBatchIdempotent([
        logicalInput(
          '20000000-0000-4000-8000-000000000014',
          'kind-newest',
          new Date('2026-07-10T10:03:00.000Z')
        ),
      ])
    );
    const second = expectOk(
      await repo.listForUser({
        userId: 'logical-user',
        view: 'all',
        cursor: first.nextCursor,
        limit: 2,
      })
    );
    expect(second.items.map((item) => item.kindId)).toEqual(['kind-old']);
  });

  it('maintains unread counts across read and archive mutations', async () => {
    const repo = getPort();
    const rows = [1, 2, 3].map((value) =>
      logicalInput(
        `20000000-0000-4000-8000-${value.toString().padStart(12, '0')}`,
        `kind-${String(value)}`,
        new Date(`2026-07-10T10:0${String(value)}:00.000Z`)
      )
    );
    expectOk(await repo.insertBatchIdempotent(rows));
    expect(expectOk(await repo.countUnread('logical-user'))).toBe(3);
    expectOk(
      await repo.setReadState({
        id: rows[0]?.id ?? '',
        userId: 'logical-user',
        readAt: new Date('2026-07-10T11:00:00.000Z'),
      })
    );
    expect(expectOk(await repo.countUnread('logical-user'))).toBe(2);
    expectOk(
      await repo.setArchivedState({
        id: rows[1]?.id ?? '',
        userId: 'logical-user',
        archivedAt: new Date('2026-07-10T11:00:00.000Z'),
      })
    );
    expect(expectOk(await repo.countUnread('logical-user'))).toBe(1);
  });

  it('scopes reads and mutations by user id', async () => {
    const repo = getPort();
    expectOk(
      await repo.insertBatchIdempotent([
        logicalInput(
          CONTRACT_LOGICAL_ID,
          'kind-owned',
          new Date('2026-07-10T10:00:00.000Z'),
          'owner'
        ),
      ])
    );
    expect(expectOk(await repo.findByIdForUser(CONTRACT_LOGICAL_ID, 'other'))).toBeNull();
    expect(
      expectOk(
        await repo.setReadState({
          id: CONTRACT_LOGICAL_ID,
          userId: 'other',
          readAt: new Date('2026-07-10T11:00:00.000Z'),
        })
      )
    ).toBe(false);
    expect(expectOk(await repo.findByIdForUser(CONTRACT_LOGICAL_ID, 'owner'))?.readAt).toBeNull();
  });

  it('finds the requested logical notification ids', async () => {
    const repo = getPort();
    const secondId = '20000000-0000-4000-8000-000000000099';
    expectOk(
      await repo.insertBatchIdempotent([
        logicalInput(CONTRACT_LOGICAL_ID, 'kind-one', new Date('2026-07-10T10:00:00.000Z')),
        logicalInput(secondId, 'kind-two', new Date('2026-07-10T10:01:00.000Z')),
      ])
    );
    const found = expectOk(await repo.findByIds([secondId, CONTRACT_LOGICAL_ID]));
    expect(new Set(found.map((logical) => logical.id))).toEqual(
      new Set([CONTRACT_LOGICAL_ID, secondId])
    );
    expect(expectOk(await repo.findByIds([]))).toEqual([]);
  });
};
