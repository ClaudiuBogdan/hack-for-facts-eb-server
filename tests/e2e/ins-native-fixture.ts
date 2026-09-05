import { type Kysely } from 'kysely';

import { makeInsSnapshotRepo } from '@/modules/ins-native/shell/repo/ins-repo.js';
import { inTrxRunner, type Trx } from '@/modules/ins-native/shell/repo/snapshot.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

/** Synthetic mutations and reads share a test transaction that ALWAYS rolls back.
 * Production's read-only enforcement is independently covered by session tests.
 */
export const inInsFixture = async (
  db: Kysely<ProdDatabase>,
  fn: (trx: Trx, repo: InsRepo) => Promise<void>
): Promise<void> => {
  const rollback = new Error('test-only rollback');
  try {
    await db.transaction().execute(async (trx) => {
      await fn(trx, makeInsSnapshotRepo(db, inTrxRunner(trx)));
      throw rollback;
    });
  } catch (cause) {
    if (cause !== rollback) throw cause;
  }
};
