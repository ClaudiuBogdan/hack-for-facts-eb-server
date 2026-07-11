import { expect, it } from 'vitest';

import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';

import { truncateUserDataTables, userDataStateCounts } from './contract-db.js';
import {
  makePlannedMutation,
  userDataEventId,
  userDataRecordId,
} from '../../fixtures/user-data/index.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { expectErr, expectOk, makeTestClock } from '../../support/index.js';

it.each(['snapshot', 'event', 'receipt'] as const)(
  'row 10: a %s-phase failure fully rolls back and leaves only a sequence gap',
  async (failedPhase) => {
    const { userDb } = await setupTestDatabase();
    await truncateUserDataTables(userDb);
    const clock = makeTestClock(new Date('2026-07-11T10:00:00.000Z'));
    const failing = makeUserDataMutationRepo({
      db: userDb,
      clock,
      testHooks: {
        beforePhase: async (phase) => {
          if (phase === failedPhase) throw new Error(`injected ${failedPhase} failure`);
        },
      },
    });
    expectErr(await failing.commit(makePlannedMutation()), 'DatabaseError');
    expect(await userDataStateCounts(userDb)).toEqual({ records: 0, events: 0, receipts: 0 });

    const succeeding = makeUserDataMutationRepo({ db: userDb, clock });
    const outcome = expectOk(
      await succeeding.commit(
        makePlannedMutation({
          operation: 'create',
          recordId: userDataRecordId(50),
          eventId: userDataEventId(50),
        })
      )
    );
    expect(outcome.kind).toBe('committed');
    if (outcome.kind === 'committed') expect(BigInt(outcome.result.eventSeq)).toBeGreaterThan(1n);
  }
);
