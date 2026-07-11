import { expect, it } from 'vitest';

import { type UserDataError } from '@/modules/user-data/core/errors.js';
import {
  type UserDataMutationPort,
  type UserDataReadPort,
} from '@/modules/user-data/core/ports.js';

import {
  makePlannedMutation,
  makeReceiptClaim,
  makeRecordIdentity,
  userDataEventId,
  userDataRecordId,
} from '../../fixtures/user-data/index.js';
import { expectErr, expectOk, type PortContractCases } from '../../support/index.js';

export interface MutationContractControls {
  advanceDays(days: number): void;
  failNextCommit(error: UserDataError): void;
  stateCounts(): Promise<{ records: number; events: number; receipts: number }>;
}

export type MutationContractPort = UserDataMutationPort &
  UserDataReadPort & { contractControls: MutationContractControls };

const commitOk = async (port: MutationContractPort, plan = makePlannedMutation()) =>
  expectOk(await port.commit(plan));

export const mutationPortContractCases: PortContractCases<MutationContractPort> = ({ getPort }) => {
  it('row 4: identical payload as a new command creates a new revision and event', async () => {
    const port = getPort();
    expect((await commitOk(port)).kind).toBe('committed');
    const second = await commitOk(
      port,
      makePlannedMutation({
        operation: 'replace',
        expectedRevision: 1,
        nextRevision: 2,
        eventId: userDataEventId(2),
        receipt: makeReceiptClaim({
          idempotencyKeyHash: 'key-2',
          canonicalRequestHash: 'request-2',
        }),
        afterImage: {
          status: 'active',
          payload: { value: 'revision-1' },
          annotations: null,
          schemaVersion: 1,
          schemaHash: 'schema-hash-1',
        },
      })
    );
    expect(second).toMatchObject({
      kind: 'committed',
      result: { eventId: userDataEventId(2), record: { revision: 2 } },
    });
  });

  it('row 5: exact replay returns the original result byte-identical', async () => {
    const port = getPort();
    const plan = makePlannedMutation();
    const first = await commitOk(port, plan);
    const second = await commitOk(port, plan);
    expect(second.kind).toBe('replayed');
    if (first.kind === 'committed' && second.kind === 'replayed')
      expect(second.result).toEqual(first.result);
  });

  it('row 6: idempotency key reuse with different content conflicts', async () => {
    const port = getPort();
    await commitOk(port);
    const conflict = await commitOk(
      port,
      makePlannedMutation({
        operation: 'replace',
        expectedRevision: 1,
        receipt: makeReceiptClaim({ canonicalRequestHash: 'different-content' }),
      })
    );
    expect(conflict.kind).toBe('idempotencyConflict');
  });

  it('row 8: an expired receipt does not replay and stale CAS conflicts', async () => {
    const port = getPort();
    const original = makePlannedMutation();
    await commitOk(port, original);
    port.contractControls.advanceDays(31);
    const stale = await commitOk(port, original);
    expect(stale).toMatchObject({ kind: 'revisionConflict', current: { revision: 1 } });
  });

  it('row 8b: a new command reusing an expired key replaces the expired receipt', async () => {
    const port = getPort();
    await commitOk(port);
    port.contractControls.advanceDays(31);
    // Same idempotency key, but a legitimate NEW command at the current revision:
    // the adapter must replace the expired receipt row, not fail on its unique key.
    const renewed = await commitOk(
      port,
      makePlannedMutation({
        operation: 'replace',
        expectedRevision: 1,
        nextRevision: 2,
        eventId: userDataEventId(10),
        receipt: makeReceiptClaim({ canonicalRequestHash: 'renewed-content' }),
        afterImage: {
          status: 'active',
          payload: { value: 'renewed' },
          annotations: null,
          schemaVersion: 1,
          schemaHash: 'schema-hash-1',
        },
      })
    );
    expect(renewed).toMatchObject({ kind: 'committed', result: { record: { revision: 2 } } });
    const replay = await commitOk(
      port,
      makePlannedMutation({
        operation: 'replace',
        expectedRevision: 1,
        nextRevision: 2,
        eventId: userDataEventId(10),
        receipt: makeReceiptClaim({ canonicalRequestHash: 'renewed-content' }),
        afterImage: {
          status: 'active',
          payload: { value: 'renewed' },
          annotations: null,
          schemaVersion: 1,
          schemaHash: 'schema-hash-1',
        },
      })
    );
    expect(replay.kind).toBe('replayed');
  });

  it('row 10: a failing commit leaves no event, snapshot, or receipt', async () => {
    const port = getPort();
    port.contractControls.failNextCommit({
      type: 'DatabaseError',
      message: 'injected',
      retryable: true,
    });
    expectErr(await port.commit(makePlannedMutation()), 'DatabaseError');
    expect(await port.contractControls.stateCounts()).toEqual({
      records: 0,
      events: 0,
      receipts: 0,
    });
  });

  it('row 11: delete tombstones and restore keeps recordId without annotations', async () => {
    const port = getPort();
    await commitOk(
      port,
      makePlannedMutation({
        operation: 'create',
        afterImage: {
          status: 'active',
          payload: { value: 'one' },
          annotations: { review: { secret: true } },
          schemaVersion: 1,
          schemaHash: 'schema-hash-1',
        },
      })
    );
    await commitOk(
      port,
      makePlannedMutation({
        operation: 'delete',
        expectedRevision: 1,
        nextRevision: 2,
        eventId: userDataEventId(11),
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
    );
    const restored = await commitOk(
      port,
      makePlannedMutation({
        operation: 'restore',
        expectedRevision: 2,
        nextRevision: 3,
        eventId: userDataEventId(12),
        receipt: makeReceiptClaim({
          idempotencyKeyHash: 'key-restore',
          canonicalRequestHash: 'restore',
        }),
        afterImage: {
          status: 'active',
          payload: { value: 'restored' },
          annotations: null,
          schemaVersion: 1,
          schemaHash: 'schema-hash-1',
        },
      })
    );
    expect(restored).toMatchObject({
      kind: 'committed',
      result: { record: { recordId: userDataRecordId(1), status: 'active', annotations: null } },
    });
  });

  it('rows 13/14: each event is its revision after-image and latest equals current', async () => {
    const port = getPort();
    await commitOk(port);
    await commitOk(
      port,
      makePlannedMutation({
        operation: 'replace',
        expectedRevision: 1,
        nextRevision: 2,
        eventId: userDataEventId(2),
        receipt: makeReceiptClaim({
          idempotencyKeyHash: 'key-2',
          canonicalRequestHash: 'request-2',
        }),
        afterImage: {
          status: 'active',
          payload: { value: 'two' },
          annotations: null,
          schemaVersion: 1,
          schemaHash: 'schema-hash-1',
        },
      })
    );
    const history = expectOk(
      await port.historyByRecord('owner-1', userDataRecordId(1), {
        limit: 10,
        beforeRevision: null,
      })
    );
    const current = expectOk(await port.findByKey('owner-1', 'test.category', 'record:1'));
    expect(history.items.map((event) => [event.revision, event.payload])).toEqual([
      [2, { value: 'two' }],
      [1, { value: 'revision-1' }],
    ]);
    expect(history.items[0]).toMatchObject({
      payload: current?.payload,
      annotations: current?.annotations,
      revision: current?.revision,
    });
    expect(history.items[0]?.eventId).toBe(current?.lastEventId);
  });

  it('row 22: annotation increments revision and appears in sync', async () => {
    const port = getPort();
    await commitOk(port);
    await commitOk(
      port,
      makePlannedMutation({
        operation: 'annotate',
        expectedRevision: 1,
        nextRevision: 2,
        eventId: userDataEventId(13),
        actor: { type: 'system', source: 'contract' },
        receipt: makeReceiptClaim({
          requesterId: 'system',
          idempotencyKeyHash: 'annotation',
          canonicalRequestHash: 'annotation',
        }),
        afterImage: {
          status: 'active',
          payload: { value: 'revision-1' },
          annotations: { review: { status: 'approved' } },
          schemaVersion: 1,
          schemaHash: 'schema-hash-1',
        },
      })
    );
    const page = expectOk(
      await port.syncSince('owner-1', { lastSeq: '1', cycleHighWater: null, category: null }, 10)
    );
    expect(page.items).toMatchObject([
      { revision: 2, annotations: { review: { status: 'approved' } } },
    ]);
  });

  it('quota: create beyond maxRecordsPerOwner is rejected', async () => {
    const port = getPort();
    await commitOk(
      port,
      makePlannedMutation({ operation: 'create', quota: { maxRecordsInCategory: 1 } })
    );
    const second = await commitOk(
      port,
      makePlannedMutation({
        operation: 'create',
        identity: makeRecordIdentity({ logicalKey: 'record:2' }),
        recordId: userDataRecordId(2),
        eventId: userDataEventId(2),
        receipt: makeReceiptClaim({
          idempotencyKeyHash: 'key-2',
          canonicalRequestHash: 'request-2',
        }),
        quota: { maxRecordsInCategory: 1 },
      })
    );
    expect(second).toEqual({ kind: 'quotaExceeded', limit: 1 });
  });
};
