import { describe, expect, it } from 'vitest';

import { annotateRecord } from '@/modules/user-data/core/usecases/annotate-record.js';
import { deleteRecord } from '@/modules/user-data/core/usecases/delete-record.js';
import { migrateRecord } from '@/modules/user-data/core/usecases/migrate-record.js';
import { replaceRecord } from '@/modules/user-data/core/usecases/replace-record.js';
import { restoreRecord } from '@/modules/user-data/core/usecases/restore-record.js';

import {
  annotateCommand,
  deleteCommand,
  makeUsecaseHarness,
  migrateCommand,
  replaceCommand,
  restoreCommand,
} from './harness.js';
import { makeFakeMutationRateLimiter } from '../../../fixtures/user-data/index.js';
import { expectErr, expectOk } from '../../../support/index.js';

const ownerInput = {
  ownerId: 'owner-1',
  requesterId: 'owner-1',
  actor: { type: 'owner' as const },
};
const systemInput = {
  ownerId: 'owner-1',
  requesterId: 'system',
  actor: { type: 'system' as const, source: 'test' },
};

describe('replaceRecord', () => {
  it('creates and maps the committed response', async () => {
    const h = makeUsecaseHarness();
    expect(
      expectOk(
        await replaceRecord(h.deps, {
          ...ownerInput,
          command: replaceCommand(),
        })
      )
    ).toMatchObject({ record: { revision: 1 }, replayed: false, eventSeq: '1' });
  });
  it('row 24 maps limiter denial to RateLimited', async () => {
    const h = makeUsecaseHarness();
    h.rateLimiter.deny(17);
    expectErr(
      await replaceRecord(h.deps, {
        ...ownerInput,
        command: replaceCommand(),
      }),
      'RateLimited'
    );
    expect(h.store.records.size()).toBe(0);
  });
  it('row 26 skips the limiter on exact replay', async () => {
    const h = makeUsecaseHarness();
    const command = replaceCommand();
    expectOk(await replaceRecord(h.deps, { ...ownerInput, command: command }));
    const replayLimiter = makeFakeMutationRateLimiter();
    replayLimiter.deny();
    const replay = expectOk(
      await replaceRecord(
        { ...h.deps, rateLimiter: replayLimiter },
        { ...ownerInput, command: command }
      )
    );
    expect(replay.replayed).toBe(true);
    expect(replayLimiter.calls).toBe(0);
  });
  it('maps probe mismatch, port failure, revision conflict, idempotency conflict, and quota', async () => {
    const mismatch = makeUsecaseHarness();
    const first = replaceCommand();
    expectOk(await replaceRecord(mismatch.deps, { ...ownerInput, command: first }));
    const reused = replaceCommand({
      receipt: { ...first.receipt, canonicalRequestHash: 'different' },
    });
    expectErr(
      await replaceRecord(mismatch.deps, {
        ...ownerInput,
        command: reused,
      }),
      'IdempotencyConflict'
    );

    const failed = makeUsecaseHarness();
    failed.store.faults.fail('getForMutation', {
      error: { type: 'DatabaseError', message: 'load', retryable: true },
    });
    expectErr(await replaceRecord(failed.deps, { ...ownerInput, command: first }), 'DatabaseError');

    const conflict = makeUsecaseHarness();
    expectOk(await replaceRecord(conflict.deps, { ...ownerInput, command: first }));
    const stale = replaceCommand({
      expectedRevision: 0,
      receipt: { ...first.receipt, idempotencyKeyHash: 'stale', canonicalRequestHash: 'stale' },
    });
    expectErr(
      await replaceRecord(conflict.deps, { ...ownerInput, command: stale }),
      'RevisionConflict'
    );

    const commitConflict = makeUsecaseHarness();
    commitConflict.store.commit = async () =>
      ({ isOk: () => true, isErr: () => false, value: { kind: 'idempotencyConflict' } }) as never;
    expectErr(
      await replaceRecord(commitConflict.deps, {
        ...ownerInput,
        command: first,
      }),
      'IdempotencyConflict'
    );
    const quota = makeUsecaseHarness();
    quota.store.commit = async () =>
      ({
        isOk: () => true,
        isErr: () => false,
        value: { kind: 'quotaExceeded', limit: 10 },
      }) as never;
    expectErr(await replaceRecord(quota.deps, { ...ownerInput, command: first }), 'QuotaExceeded');
  });
});

describe('annotateRecord', () => {
  it('annotates for a system actor and rejects owner actors before planning', async () => {
    const h = makeUsecaseHarness();
    const create = replaceCommand();
    expectOk(await replaceRecord(h.deps, { ...ownerInput, command: create }));
    const command = annotateCommand();
    expect(
      expectOk(await annotateRecord(h.deps, { ...systemInput, command: command }))
    ).toMatchObject({ record: { revision: 2, annotations: { review: { status: 'approved' } } } });
    const ownerCommand = annotateCommand({
      receipt: { ...command.receipt, idempotencyKeyHash: 'owner-annotation' },
    });
    expectErr(
      await annotateRecord(h.deps, {
        ...ownerInput,
        command: ownerCommand,
      }),
      'ActorNotAllowed'
    );
  });
  it('returns NotFound for a missing record', async () => {
    const h = makeUsecaseHarness();
    const command = annotateCommand();
    expectErr(await annotateRecord(h.deps, { ...systemInput, command: command }), 'NotFound');
  });
});

describe('deleteRecord and restoreRecord', () => {
  it('tombstones then restores the same record without annotations', async () => {
    const h = makeUsecaseHarness();
    const create = replaceCommand();
    expectOk(await replaceRecord(h.deps, { ...ownerInput, command: create }));
    const deletion = deleteCommand();
    expect(
      expectOk(await deleteRecord(h.deps, { ...ownerInput, command: deletion }))
    ).toMatchObject({ record: { status: 'deleted', payload: null } });
    const restore = restoreCommand();
    expect(
      expectOk(await restoreRecord(h.deps, { ...ownerInput, command: restore }))
    ).toMatchObject({ record: { recordId: 'usecase-1', status: 'active', annotations: null } });
  });
  it('both return NotFound for missing records', async () => {
    const h = makeUsecaseHarness();
    const deletion = deleteCommand();
    const restore = restoreCommand();
    expectErr(await deleteRecord(h.deps, { ...ownerInput, command: deletion }), 'NotFound');
    expectErr(await restoreRecord(h.deps, { ...ownerInput, command: restore }), 'NotFound');
  });
});

describe('migrateRecord', () => {
  it('migrates without consuming the client limiter and requires system actor', async () => {
    const h = makeUsecaseHarness();
    const create = replaceCommand();
    expectOk(await replaceRecord(h.deps, { ...ownerInput, command: create }));
    const command = migrateCommand();
    expect(
      expectOk(await migrateRecord(h.deps, { ...systemInput, command: command }))
    ).toMatchObject({ record: { revision: 2, payload: { value: 'migrated' } } });
    expect(h.rateLimiter.calls).toBe(1);
    const denied = migrateCommand({
      receipt: { ...command.receipt, idempotencyKeyHash: 'owner-migrate' },
    });
    expectErr(await migrateRecord(h.deps, { ...ownerInput, command: denied }), 'ActorNotAllowed');
  });
});
