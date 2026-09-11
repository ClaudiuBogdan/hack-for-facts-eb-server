/**
 * Native Chronos INS reads: the snapshot policy (`makeInsRepo`,
 * `makeInsSnapshotRepo`, `withInsReadSnapshot`) and the assembly of the three
 * read families, `ins-publication.ts`, `ins-territory.ts` and `ins-series.ts`
 * (codebase plan §WP5). All reads and hydration share a repeatable-read,
 * read-only snapshot.
 */
import { sql } from 'kysely';
import { err, type Result } from 'neverthrow';

import { makePublicationReads } from './ins-publication.js';
import { makeSeriesReads } from './ins-series.js';
import { makeTerritoryReads } from './ins-territory.js';
import {
  dbError,
  INS_TRANSACTION_TIMEOUT_MS,
  inTrxRunner,
  openSnapshot,
  perReadRunner,
  type Db,
  type Runner,
  type Trx,
} from './snapshot.js';

import type { InsRepo } from '../../core/ports.js';
import type { ApiError } from '@/modules/shared/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// The repository
// ─────────────────────────────────────────────────────────────────────────────

export const makeInsRepo = (db: Db): InsRepo => makeRepoOn(db, perReadRunner(db));

/** Module-private assembly seam: every nested usecase retains this snapshot. */
export const makeInsSnapshotRepo = (db: Db, runner: Runner): InsRepo =>
  makeRepoOn(db, runner, true);

/** Compose canonical identity and native INS reads within one read-only snapshot. */
export const withInsReadSnapshot = <T>(
  db: Db,
  fn: (context: { trx: Trx; repo: InsRepo }) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> =>
  openSnapshot(db, async (trx) => {
    await sql`set local transaction_timeout = ${sql.lit(INS_TRANSACTION_TIMEOUT_MS)}`.execute(trx);
    return fn({ trx, repo: makeInsSnapshotRepo(db, inTrxRunner(trx)) });
  }).catch((cause: unknown) => err(dbError(cause, 'composed snapshot')));

const makeRepoOn = (db: Db, readTx: Runner, snapshotBound = false): InsRepo => {
  const repository: InsRepo = {
    ...makeSeriesReads(readTx),
    ...makeTerritoryReads(readTx),
    ...makePublicationReads(readTx),
    withSnapshot(fn) {
      if (snapshotBound) return fn(repository);
      return openSnapshot(db, (trx) => fn(makeRepoOn(db, inTrxRunner(trx), true))).catch(
        (cause: unknown) => err(dbError(cause, 'withSnapshot'))
      );
    },
  };

  return repository;
};
