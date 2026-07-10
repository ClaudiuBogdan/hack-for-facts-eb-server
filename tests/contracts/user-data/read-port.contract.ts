import { expect, it } from 'vitest';

import {
  type UserDataMutationPort,
  type UserDataReadPort,
} from '@/modules/user-data/core/ports.js';

import {
  makePlannedMutation,
  makeReceiptClaim,
  makeRecordIdentity,
} from '../../fixtures/user-data/index.js';
import { expectOk, type PortContractCases } from '../../support/index.js';

export type ReadContractPort = UserDataReadPort & UserDataMutationPort;

const create = async (
  port: ReadContractPort,
  suffix: number,
  ownerId = 'owner-1',
  category = 'test.category'
) => {
  const identity = makeRecordIdentity({
    ownerId,
    category,
    logicalKey: `record:${String(suffix)}`,
  });
  const result = expectOk(
    await port.commit(
      makePlannedMutation({
        operation: 'create',
        identity,
        recordId: `record-id-${String(suffix)}`,
        eventId: `event-${String(suffix)}`,
        receipt: makeReceiptClaim({
          requesterId: ownerId,
          idempotencyKeyHash: `key-${ownerId}-${String(suffix)}`,
          canonicalRequestHash: `request-${String(suffix)}`,
        }),
      })
    )
  );
  expect(result.kind).toBe('committed');
  return identity;
};

export const readPortContractCases: PortContractCases<ReadContractPort> = ({ getPort }) => {
  it('findByKey and findById are owner-scoped', async () => {
    const port = getPort();
    await create(port, 1);
    expect(expectOk(await port.findByKey('owner-1', 'test.category', 'record:1'))?.recordId).toBe(
      'record-id-1'
    );
    expect(expectOk(await port.findById('owner-1', 'record-id-1'))?.identity.ownerId).toBe(
      'owner-1'
    );
    expect(expectOk(await port.findByKey('other-owner', 'test.category', 'record:1'))).toBeNull();
    expect(expectOk(await port.findById('other-owner', 'record-id-1'))).toBeNull();
  });

  it('listByCategory uses a stable logical-key keyset', async () => {
    const port = getPort();
    await create(port, 3);
    await create(port, 1);
    await create(port, 2);
    const first = expectOk(
      await port.listByCategory('owner-1', 'test.category', { limit: 2, cursor: null })
    );
    const second = expectOk(
      await port.listByCategory('owner-1', 'test.category', { limit: 2, cursor: first.nextCursor })
    );
    expect([...first.items, ...second.items].map((record) => record.identity.logicalKey)).toEqual([
      'record:1',
      'record:2',
      'record:3',
    ]);
  });

  it('syncSince orders snapshots, includes tombstones, and reports ownerHighWater', async () => {
    const port = getPort();
    await create(port, 1);
    await create(port, 2);
    expectOk(
      await port.commit(
        makePlannedMutation({
          operation: 'delete',
          identity: makeRecordIdentity({ logicalKey: 'record:1' }),
          recordId: 'record-id-1',
          expectedRevision: 1,
          nextRevision: 2,
          eventId: 'event-delete',
          receipt: makeReceiptClaim({
            idempotencyKeyHash: 'key-delete',
            canonicalRequestHash: 'delete',
          }),
          afterImage: {
            status: 'deleted',
            payload: null,
            annotations: null,
            schemaVersion: 1,
            schemaHash: 'schema-hash-1',
          },
        })
      )
    );
    await create(port, 9, 'other-owner');
    const page = expectOk(
      await port.syncSince('owner-1', { lastSeq: '0', cycleHighWater: null, category: null }, 10)
    );
    expect(
      page.items.map((record) => [record.identity.logicalKey, record.status, record.lastEventSeq])
    ).toEqual([
      ['record:2', 'active', '2'],
      ['record:1', 'deleted', '3'],
    ]);
    expect(page.ownerHighWater).toBe('3');
  });

  it('historyByRecord paginates by descending revision', async () => {
    const port = getPort();
    await create(port, 1);
    for (const revision of [2, 3]) {
      expectOk(
        await port.commit(
          makePlannedMutation({
            operation: 'replace',
            expectedRevision: revision - 1,
            nextRevision: revision,
            eventId: `event-r${String(revision)}`,
            receipt: makeReceiptClaim({
              idempotencyKeyHash: `key-r${String(revision)}`,
              canonicalRequestHash: `request-r${String(revision)}`,
            }),
          })
        )
      );
    }
    const first = expectOk(
      await port.historyByRecord('owner-1', 'record-id-1', { limit: 2, beforeRevision: null })
    );
    const second = expectOk(
      await port.historyByRecord('owner-1', 'record-id-1', { limit: 2, beforeRevision: 2 })
    );
    expect(first.items.map((event) => event.revision)).toEqual([3, 2]);
    expect(second.items.map((event) => event.revision)).toEqual([1]);
  });
};
