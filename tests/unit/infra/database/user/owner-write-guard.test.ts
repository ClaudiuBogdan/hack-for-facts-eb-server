/**
 * The user-data owner write fence (`assertUserDataOwnerCanWrite`, review
 * T-06), pinned over the capturing driver on a `UserDatabase` transaction:
 * an empty or untrimmed owner id is refused BEFORE any statement; the
 * transaction-scoped advisory lock (namespace 20260711, hashtext of the id)
 * is taken before the anonymization-audit marker is read; the marker lookup
 * is by the sha256 of the id; any marker row refuses the write, no marker
 * admits it, and a driver failure on either statement propagates instead of
 * admitting.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertUserDataOwnerCanWrite,
  UserDataOwnerDeletedError,
} from '@/infra/database/user/owner-write-guard.js';

import { makeCapturingDb, type CapturedQuery } from '../../../../fixtures/capturing-db.js';

import type { UserDatabase } from '@/infra/database/user/types.js';

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

const OWNER = 'user_2abc';
const OWNER_HASH = createHash('sha256').update(OWNER).digest('hex');

const isMarkerRead = (sql: string): boolean =>
  flat(sql).includes('from "userdataanonymizationaudit"');

const run = async (
  ownerId: string,
  markerRows: readonly unknown[] = [],
  failWith?: { on: 'lock' | 'marker'; error: Error }
): Promise<{ captured: CapturedQuery[]; outcome: 'admitted' | Error }> => {
  const captured: CapturedQuery[] = [];
  const db = makeCapturingDb<UserDatabase>(captured, {
    respond: (sql) => {
      const marker = isMarkerRead(sql);
      if (failWith !== undefined && (failWith.on === 'marker') === marker) throw failWith.error;
      return marker ? markerRows : [];
    },
  });
  try {
    await db.transaction().execute((trx) => assertUserDataOwnerCanWrite(trx, ownerId));
    return { captured, outcome: 'admitted' };
  } catch (error) {
    return { captured, outcome: error as Error };
  }
};

describe('assertUserDataOwnerCanWrite', () => {
  it('takes the owner advisory lock, then reads the audit marker by sha256, and admits without a marker', async () => {
    const { captured, outcome } = await run(OWNER);
    expect(outcome).toBe('admitted');
    expect(captured.map((c) => flat(c.sql))).toEqual([
      'select pg_advisory_xact_lock( $1, hashtext($2) )',
      'select "user_id_hash" from "userdataanonymizationaudit" where "user_id_hash" = $1',
    ]);
    expect(captured.map((c) => c.parameters)).toEqual([[20_260_711, OWNER], [OWNER_HASH]]);
  });

  it('refuses an owner with an audit marker (started, failed or completed deletions alike)', async () => {
    const { captured, outcome } = await run(OWNER, [{ user_id_hash: OWNER_HASH }]);
    expect(outcome).toBeInstanceOf(UserDataOwnerDeletedError);
    expect((outcome as Error).message).toBe('This account can no longer write user data');
    // The lock was still taken first: a concurrent deletion serializes behind it.
    expect(captured.map((c) => flat(c.sql))).toEqual([
      'select pg_advisory_xact_lock( $1, hashtext($2) )',
      'select "user_id_hash" from "userdataanonymizationaudit" where "user_id_hash" = $1',
    ]);
  });

  it.each(['', ' user_2abc', 'user_2abc ', '\tuser_2abc\n'])(
    'refuses the identity %j before taking the lock',
    async (ownerId) => {
      const { captured, outcome } = await run(ownerId);
      expect(outcome).toBeInstanceOf(UserDataOwnerDeletedError);
      expect(captured).toEqual([]);
    }
  );

  it.each(['lock', 'marker'] as const)(
    'propagates a driver failure on the %s statement instead of admitting the write',
    async (on) => {
      const cause = new Error('connection reset');
      const { captured, outcome } = await run(OWNER, [], { on, error: cause });
      expect(outcome).toBe(cause);
      expect(captured).toHaveLength(on === 'lock' ? 1 : 2);
    }
  );
});
