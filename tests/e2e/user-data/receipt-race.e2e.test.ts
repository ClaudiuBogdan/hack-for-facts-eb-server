import { beforeEach, expect, it } from 'vitest';

import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';

import { truncateUserDataTables, userDataStateCounts } from './contract-db.js';
import { deferred } from './race-helpers.js';
import {
  makePlannedMutation,
  makeReceiptClaim,
  makeRecordIdentity,
  userDataEventId,
  userDataRecordId,
} from '../../fixtures/user-data/index.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { expectOk, makeTestClock } from '../../support/index.js';

const clock = makeTestClock(new Date('2026-07-11T10:00:00.000Z'));

beforeEach(async () => {
  const { userDb } = await setupTestDatabase();
  await truncateUserDataTables(userDb);
});

const runReceiptRace = async (canonicalB: string) => {
  const { userDb } = await setupTestDatabase();
  const aAtReceipt = deferred();
  const releaseA = deferred();
  const claimA = makeReceiptClaim({
    requesterId: 'privileged-requester',
    idempotencyKeyHash: 'shared-key',
    canonicalRequestHash: 'same-request',
  });
  const repoA = makeUserDataMutationRepo({
    db: userDb,
    clock,
    testHooks: {
      beforePhase: async (phase) => {
        if (phase !== 'receipt') return;
        aAtReceipt.resolve();
        await releaseA.promise;
      },
    },
  });
  const repoB = makeUserDataMutationRepo({ db: userDb, clock });
  const planA = makePlannedMutation({
    operation: 'create',
    identity: makeRecordIdentity({ ownerId: 'owner-a' }),
    recordId: userDataRecordId(30),
    eventId: userDataEventId(30),
    receipt: claimA,
  });
  const planB = makePlannedMutation({
    operation: 'create',
    identity: makeRecordIdentity({ ownerId: 'owner-b' }),
    recordId: userDataRecordId(31),
    eventId: userDataEventId(31),
    receipt: { ...claimA, canonicalRequestHash: canonicalB },
  });

  // Deterministic winner: A pauses inside its transaction (snapshot and event
  // already written, receipt not yet inserted) while B — a different owner, so
  // a different advisory lock — runs to a full commit. Releasing A then forces
  // A's receipt insert onto B's committed row: ON CONFLICT fires, the loser
  // rolls back its snapshot and event, and resolves from B's receipt.
  const commitA = repoA.commit(planA);
  await aAtReceipt.promise;
  const winner = expectOk(await repoB.commit(planB));
  releaseA.resolve();
  return {
    winner,
    loser: expectOk(await commitA),
    counts: await userDataStateCounts(userDb),
  };
};

it('row 7: same claim under different owner locks replays the winner', async () => {
  const result = await runReceiptRace('same-request');
  expect(result.winner.kind).toBe('committed');
  expect(result.loser.kind).toBe('replayed');
  if (result.winner.kind === 'committed' && result.loser.kind === 'replayed')
    expect(result.loser.result).toEqual(result.winner.result);
  expect(result.counts).toEqual({ records: 1, events: 1, receipts: 1 });
});

it('row 7: different claim under different owner locks conflicts', async () => {
  const result = await runReceiptRace('different-request');
  expect(result.winner.kind).toBe('committed');
  expect(result.loser.kind).toBe('idempotencyConflict');
  expect(result.counts).toEqual({ records: 1, events: 1, receipts: 1 });
});
