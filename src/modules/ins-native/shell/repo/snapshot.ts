import { sql, type Kysely, type Transaction } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import type { ApiError, ProdDatabase } from '@/modules/shared/index.js';

/** Interactive read budget; exports get their own path (plan §3.3). */
export const INS_READ_TIMEOUT_MS = 30_000;

export type Db = Kysely<ProdDatabase>;
export type Trx = Transaction<ProdDatabase>;

const isStatementTimeout = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014') return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('statement timeout');
};

export const dbError = (cause: unknown, what: string): ApiError =>
  isStatementTimeout(cause)
    ? { type: 'Timeout', message: `ins repository timed out: ${what}` }
    : { type: 'Database', message: `ins repository failed: ${what}`, cause };

/** Runs one read inside a repeatable-read, read-only transaction (or an enclosing one). */
export type Runner = <T>(
  what: string,
  fn: (trx: Trx) => Promise<T>
) => Promise<Result<T, ApiError>>;

export const openSnapshot = async <T>(db: Db, fn: (trx: Trx) => Promise<T>): Promise<T> =>
  db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      await sql`set local statement_timeout = ${sql.lit(INS_READ_TIMEOUT_MS)}`.execute(trx);
      return fn(trx);
    });

/** A fresh snapshot per read (the default when no request-level snapshot is open). */
export const perReadRunner =
  (db: Db): Runner =>
  async (what, fn) => {
    try {
      return ok(await openSnapshot(db, fn));
    } catch (cause) {
      return err(dbError(cause, what));
    }
  };

/** Every read inside ONE already-open snapshot. */
export const inTrxRunner =
  (trx: Trx): Runner =>
  async (what, fn) => {
    try {
      return ok(await fn(trx));
    } catch (cause) {
      return err(dbError(cause, what));
    }
  };
