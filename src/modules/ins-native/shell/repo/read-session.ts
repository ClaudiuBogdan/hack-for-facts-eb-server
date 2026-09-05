import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { makeInsSnapshotRepo } from './ins-repo.js';
import { dbError, inTrxRunner, openSnapshot, type Db, type Runner } from './snapshot.js';

import type { InsRepo } from '../../core/ports.js';
import type { ApiError } from '@/modules/shared/index.js';

/** One operation owns one lazily acquired, read-only publication snapshot. */
export interface InsReadSession {
  getRepo(): Promise<Result<InsRepo, ApiError>>;
  close(): Promise<Result<void, ApiError>>;
}

// Interactive policy limits, not measured query-performance thresholds. A
// deadline stops new work; PostgreSQL's transaction limit bounds admitted SQL.
export const INS_OPERATION_TIMEOUT_MS = 30_000;
const INS_TRANSACTION_TIMEOUT_MS = 35_000;

export const makeInsReadSession = (db: Db): InsReadSession => {
  // Promise executors run synchronously, before either resolver is used.
  let publish!: (value: Result<InsRepo, ApiError>) => void;
  const ready = new Promise<Result<InsRepo, ApiError>>((resolve) => {
    publish = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let failed: ApiError | undefined;
  let readQueue: Promise<void> = Promise.resolve();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let lifetime: Promise<Result<void, ApiError>> | undefined;
  let closeResult: Promise<Result<void, ApiError>> | undefined;
  let closedError: ApiError = {
    type: 'ServiceUnavailable',
    message: 'INS operation has ended',
  };

  const close = (): Promise<Result<void, ApiError>> => {
    if (closeResult !== undefined) return closeResult;
    // Close admission synchronously, including while pool acquisition is pending.
    closing = true;
    if (deadline !== undefined) clearTimeout(deadline);
    publish(err(closedError));
    finish();
    closeResult = lifetime ?? Promise.resolve(ok(undefined));
    return closeResult;
  };

  const start = (): void => {
    deadline = setTimeout(() => {
      closedError = { type: 'Timeout', message: 'INS operation deadline exceeded' };
      void close(); // lifetime converts transaction failures to a handled Result.
    }, INS_OPERATION_TIMEOUT_MS);
    deadline.unref();
    // The callback transaction's connection provider releases in finally, even
    // when BEGIN or transaction cleanup fails. Do not use a controlled Kysely
    // transaction here: its public API cannot release after those failures.
    lifetime = openSnapshot(db, async (trx) => {
      await sql`set local transaction_timeout = ${sql.lit(INS_TRANSACTION_TIMEOUT_MS)}`.execute(
        trx
      );
      const read = inTrxRunner(trx);
      const admitted: Runner = (what, fn) => {
        if (closing) return Promise.resolve(err(closedError));
        // A savepoint belongs to the whole repository read, including hydration.
        // Serialize reads so sibling multi-statement queries cannot interleave
        // savepoints and accidentally undo each other's work.
        const work = readQueue.then(async () => {
          if (closing) return err(closedError);
          let readFailure: ApiError | undefined;
          try {
            await sql`savepoint ins_operation_read`.execute(trx);
            const result = await read(what, fn);
            if (result.isErr()) {
              readFailure = result.error;
              await sql`rollback to savepoint ins_operation_read`.execute(trx);
            }
            await sql`release savepoint ins_operation_read`.execute(trx);
            return result;
          } catch (cause) {
            // If savepoint recovery itself fails, preserve one original error
            // for every queued read and stop admitting work into this session.
            failed = readFailure ?? dbError(cause, what);
            closedError = failed;
            void close();
            return err(failed);
          }
        });
        readQueue = work.then(
          () => undefined,
          () => undefined
        );
        pending.add(work);
        // Both handlers remove the promise; no unhandled finally-derived reject.
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work)
        );
        return work;
      };
      if (!closing) publish(ok(makeInsSnapshotRepo(db, admitted)));
      await finished;
      // Error bubbling can finish GraphQL before sibling resolver reads finish.
      // Admission is now closed, so this is the entire outstanding read set.
      await Promise.allSettled([...pending]);
      if (failed !== undefined) throw new Error('INS snapshot recovery failed', { cause: failed });
    }).then(
      () => ok(undefined),
      (cause: unknown) => {
        const error = failed ?? dbError(cause, 'readSession');
        closedError = error;
        closing = true;
        if (deadline !== undefined) clearTimeout(deadline);
        publish(err(error));
        return err(error);
      }
    );
  };

  return {
    async getRepo() {
      if (closing) return err(closedError);
      if (lifetime === undefined) start();
      const result = await ready;
      // close() can run while awaiting acquisition; TypeScript retains the old narrowing.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() can change state during the await.
      return closing ? err(closedError) : result;
    },
    close,
  };
};
