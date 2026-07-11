import { expect, it } from 'vitest';

import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';

import { truncateUserDataTables } from './contract-db.js';
import { deferred, waitForBlockedAdvisoryLock } from './race-helpers.js';
import {
  makePlannedMutation,
  makeReceiptClaim,
  makeRecordIdentity,
  userDataEventId,
  userDataRecordId,
} from '../../fixtures/user-data/index.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { expectOk, makeTestClock } from '../../support/index.js';

it('row 24: quota is authoritative under concurrent creates', async () => {
  const { userDb } = await setupTestDatabase();
  await truncateUserDataTables(userDb);
  const clock = makeTestClock(new Date('2026-07-11T10:00:00.000Z'));
  const plain = makeUserDataMutationRepo({ db: userDb, clock });
  expect(expectOk(await plain.commit(makePlannedMutation())).kind).toBe('committed');

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
  const plan = (suffix: number) =>
    makePlannedMutation({
      operation: 'create',
      identity: makeRecordIdentity({ logicalKey: `record:${String(suffix)}` }),
      recordId: userDataRecordId(suffix),
      eventId: userDataEventId(suffix),
      receipt: makeReceiptClaim({
        idempotencyKeyHash: `quota-${String(suffix)}`,
        canonicalRequestHash: `quota-${String(suffix)}`,
      }),
      quota: { maxRecordsInCategory: 2 },
    });

  const commitA = repoA.commit(plan(40));
  await aAtReceipt.promise;
  const commitB = plain.commit(plan(41));
  await waitForBlockedAdvisoryLock(userDb);
  releaseA.resolve();
  const outcomes = [expectOk(await commitA), expectOk(await commitB)];
  expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['committed', 'quotaExceeded']);
  const count = await userDb
    .selectFrom('user_data_records')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  expect(count.count).toBe('2');
});
