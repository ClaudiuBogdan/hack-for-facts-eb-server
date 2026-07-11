import { sql } from 'kysely';
import { beforeEach, expect, it } from 'vitest';

import { syncRecords } from '@/modules/user-data/core/usecases/sync-records.js';
import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';
import { makeUserDataReadRepo } from '@/modules/user-data/shell/repo/kysely-user-data-read-repo.js';

import { truncateUserDataTables } from './contract-db.js';
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
const logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

beforeEach(async () => {
  const { userDb } = await setupTestDatabase();
  await truncateUserDataTables(userDb);
});

it('row 25: an in-flight owner sequence cannot advance that owner sync cursor', async () => {
  const { userDb } = await setupTestDatabase();
  const xAtEvent = deferred();
  const releaseX = deferred();
  const readRepo = makeUserDataReadRepo({ db: userDb });
  const mutationX = makeUserDataMutationRepo({
    db: userDb,
    clock,
    testHooks: {
      beforePhase: async (phase) => {
        if (phase !== 'event') return;
        xAtEvent.resolve();
        await releaseX.promise;
      },
    },
  });
  const mutationY = makeUserDataMutationRepo({ db: userDb, clock });
  const planX = makePlannedMutation({
    operation: 'create',
    identity: makeRecordIdentity({ ownerId: 'owner-x', logicalKey: 'record:x' }),
    recordId: userDataRecordId(70),
    eventId: userDataEventId(70),
    receipt: makeReceiptClaim({
      requesterId: 'owner-x',
      idempotencyKeyHash: 'owner-x-create',
      canonicalRequestHash: 'owner-x-create',
    }),
  });
  const planY = makePlannedMutation({
    operation: 'create',
    identity: makeRecordIdentity({ ownerId: 'owner-y', logicalKey: 'record:y' }),
    recordId: userDataRecordId(71),
    eventId: userDataEventId(71),
    receipt: makeReceiptClaim({
      requesterId: 'owner-y',
      idempotencyKeyHash: 'owner-y-create',
      canonicalRequestHash: 'owner-y-create',
    }),
  });

  const commitX = mutationX.commit(planX);
  await xAtEvent.promise;
  const allocated = await sql<{ value: string }>`
    SELECT last_value::text AS value FROM user_data_event_seq
  `.execute(userDb);
  const sequenceX = allocated.rows[0]?.value;
  if (sequenceX === undefined) throw new Error('Expected owner X sequence allocation');

  const resultY = expectOk(await mutationY.commit(planY));
  expect(resultY.kind).toBe('committed');
  if (resultY.kind === 'committed')
    expect(BigInt(resultY.result.eventSeq)).toBe(BigInt(sequenceX) + 1n);

  const visible = expectOk(
    await readRepo.syncSince('owner-x', { lastSeq: '0', cycleHighWater: null, category: null }, 10)
  );
  expect(visible.items).toEqual([]);
  expect(BigInt(visible.ownerHighWater)).toBeLessThan(BigInt(sequenceX));

  const beforeCommit = expectOk(
    await syncRecords(
      { readPort: readRepo, logger },
      { ownerId: 'owner-x', rawCursor: null, category: null }
    )
  );
  expect(beforeCommit.items).toEqual([]);

  releaseX.resolve();
  expect(expectOk(await commitX).kind).toBe('committed');
  const afterCommit = expectOk(
    await syncRecords(
      { readPort: readRepo, logger },
      { ownerId: 'owner-x', rawCursor: beforeCommit.nextCursor, category: null }
    )
  );
  expect(afterCommit.items.map((record) => record.logicalKey)).toEqual(['record:x']);
});

it('row 12: a record changed twice between pages is returned once in its latest state', async () => {
  const { userDb } = await setupTestDatabase();
  const mutation = makeUserDataMutationRepo({ db: userDb, clock });
  const readRepo = makeUserDataReadRepo({ db: userDb });
  const ownerId = 'owner-cycle';
  const identityOne = makeRecordIdentity({ ownerId, logicalKey: 'record:cycle-1' });
  const identityTwo = makeRecordIdentity({ ownerId, logicalKey: 'record:cycle-2' });

  for (const [suffix, identity] of [
    [80, identityOne],
    [81, identityTwo],
  ] as const) {
    expect(
      expectOk(
        await mutation.commit(
          makePlannedMutation({
            operation: 'create',
            identity,
            recordId: userDataRecordId(suffix),
            eventId: userDataEventId(suffix),
            receipt: makeReceiptClaim({
              requesterId: ownerId,
              idempotencyKeyHash: `create-${String(suffix)}`,
              canonicalRequestHash: `create-${String(suffix)}`,
            }),
          })
        )
      ).kind
    ).toBe('committed');
  }

  const firstPage = expectOk(
    await syncRecords(
      { readPort: readRepo, logger },
      { ownerId, rawCursor: null, category: null, limit: 1 }
    )
  );
  expect(firstPage.hasMore).toBe(true);

  for (const revision of [2, 3]) {
    expect(
      expectOk(
        await mutation.commit(
          makePlannedMutation({
            operation: 'replace',
            identity: identityTwo,
            recordId: userDataRecordId(81),
            expectedRevision: revision - 1,
            nextRevision: revision,
            eventId: userDataEventId(81 + revision),
            receipt: makeReceiptClaim({
              requesterId: ownerId,
              idempotencyKeyHash: `replace-${String(revision)}`,
              canonicalRequestHash: `replace-${String(revision)}`,
            }),
          })
        )
      ).kind
    ).toBe('committed');
  }

  const finishOldCycle = expectOk(
    await syncRecords(
      { readPort: readRepo, logger },
      { ownerId, rawCursor: firstPage.nextCursor, category: null, limit: 1 }
    )
  );
  expect(finishOldCycle.items).toEqual([]);
  expect(finishOldCycle.hasMore).toBe(false);

  const nextCycle = expectOk(
    await syncRecords(
      { readPort: readRepo, logger },
      { ownerId, rawCursor: finishOldCycle.nextCursor, category: null, limit: 10 }
    )
  );
  expect(nextCycle.items).toHaveLength(1);
  expect(nextCycle.items[0]).toMatchObject({ logicalKey: 'record:cycle-2', revision: 3 });
});
