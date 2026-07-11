import { expect, it } from 'vitest';

import {
  type UserDataErasurePort,
  type UserDataMutationPort,
  type UserDataReadPort,
} from '@/modules/user-data/core/ports.js';

import {
  makePlannedMutation,
  makeReceiptClaim,
  userDataRecordId,
} from '../../fixtures/user-data/index.js';
import { expectOk, type PortContractCases } from '../../support/index.js';

export type ErasureContractPort = UserDataErasurePort & UserDataMutationPort & UserDataReadPort;

export const erasurePortContractCases: PortContractCases<ErasureContractPort> = ({ getPort }) => {
  it('redacts current rows and events, deletes receipts, and is idempotent', async () => {
    const port = getPort();
    const claim = makeReceiptClaim();
    expectOk(
      await port.commit(
        makePlannedMutation({
          operation: 'create',
          receipt: claim,
          afterImage: {
            status: 'active',
            payload: { secret: 'payload', keep: true },
            annotations: { review: { secret: 'annotation', keep: true } },
            schemaVersion: 1,
            schemaHash: 'schema-hash-1',
          },
        })
      )
    );
    const now = new Date('2026-07-11T12:00:00.000Z');
    const first = expectOk(
      await port.eraseOwner({
        ownerId: 'owner-1',
        anonymizedOwnerId: 'anonymous-1',
        now,
        redactors: {
          payloadByCategory: Object.fromEntries([
            ['test.category', (payload: Record<string, unknown>) => ({ keep: payload['keep'] })],
          ]),
          annotationsByCategory: Object.fromEntries([
            [
              'test.category',
              { review: (annotation: Record<string, unknown>) => ({ keep: annotation['keep'] }) },
            ],
          ]),
        },
      })
    );
    expect(first).toEqual({ records: 1, events: 1, receipts: 1 });
    expect(expectOk(await port.findByKey('owner-1', 'test.category', 'record:1'))).toBeNull();
    const current = expectOk(await port.findByKey('anonymous-1', 'test.category', 'record:1'));
    expect(current).toMatchObject({
      payload: { keep: true },
      annotations: { review: { keep: true } },
      privacyRedactedAt: now,
    });
    const history = expectOk(
      await port.historyByRecord('anonymous-1', userDataRecordId(1), {
        limit: 10,
        beforeRevision: null,
      })
    );
    expect(history.items[0]).toMatchObject({
      payload: { keep: true },
      annotations: { review: { keep: true } },
      privacyRedactedAt: now,
    });
    expect(expectOk(await port.probeReceipt(claim))).toBe('absent');
    expect(
      expectOk(
        await port.eraseOwner({
          ownerId: 'owner-1',
          anonymizedOwnerId: 'anonymous-1',
          now,
          redactors: { payloadByCategory: {}, annotationsByCategory: {} },
        })
      )
    ).toEqual({ records: 0, events: 0, receipts: 0 });
  });
};
