import { beforeEach, expect, it } from 'vitest';

import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';

import { truncateUserDataTables } from './contract-db.js';
import { deferred, waitForBlockedAdvisoryLock } from './race-helpers.js';
import {
  makePlannedMutation,
  makeReceiptClaim,
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

it('rows 2/3: same-revision replacements serialize and exactly one wins', async () => {
  const { userDb } = await setupTestDatabase();
  const seed = makeUserDataMutationRepo({ db: userDb, clock });
  expect(expectOk(await seed.commit(makePlannedMutation())).kind).toBe('committed');

  const aAtReceipt = deferred();
  const releaseA = deferred();
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
    operation: 'replace',
    expectedRevision: 1,
    nextRevision: 2,
    eventId: userDataEventId(20),
    receipt: makeReceiptClaim({ idempotencyKeyHash: 'cas-a', canonicalRequestHash: 'cas-a' }),
  });
  const planB = makePlannedMutation({
    operation: 'replace',
    expectedRevision: 1,
    nextRevision: 2,
    eventId: userDataEventId(21),
    receipt: makeReceiptClaim({ idempotencyKeyHash: 'cas-b', canonicalRequestHash: 'cas-b' }),
  });

  const commitA = repoA.commit(planA);
  await aAtReceipt.promise;
  const commitB = repoB.commit(planB);
  await waitForBlockedAdvisoryLock(userDb);
  releaseA.resolve();

  const outcomes = [expectOk(await commitA), expectOk(await commitB)];
  expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['committed', 'revisionConflict']);
});

it('row 2: two creates of one identity return the winner in the conflict', async () => {
  const { userDb } = await setupTestDatabase();
  const aAtReceipt = deferred();
  const releaseA = deferred();
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
    recordId: userDataRecordId(20),
    eventId: userDataEventId(22),
    receipt: makeReceiptClaim({ idempotencyKeyHash: 'create-a', canonicalRequestHash: 'create-a' }),
  });
  const planB = makePlannedMutation({
    operation: 'create',
    recordId: userDataRecordId(21),
    eventId: userDataEventId(23),
    receipt: makeReceiptClaim({ idempotencyKeyHash: 'create-b', canonicalRequestHash: 'create-b' }),
  });

  const commitA = repoA.commit(planA);
  await aAtReceipt.promise;
  const commitB = repoB.commit(planB);
  await waitForBlockedAdvisoryLock(userDb);
  releaseA.resolve();

  const first = expectOk(await commitA);
  const second = expectOk(await commitB);
  expect(first.kind).toBe('committed');
  expect(second).toMatchObject({
    kind: 'revisionConflict',
    current: { recordId: userDataRecordId(20) },
  });
});
