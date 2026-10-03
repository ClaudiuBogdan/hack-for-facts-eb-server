/**
 * National budget — a Kysely driver that emulates the PostgreSQL behaviour the
 * read port depends on, without a database:
 *
 * - connection acquisition can be delayed (a busy pool);
 * - each statement can take time; `set local statement_timeout = N` cancels a
 *   longer statement after N ms with SQLSTATE 57014, server-side, leaving the
 *   connection usable (the transaction then rolls back);
 * - `transaction_timeout` as PostgreSQL 18 runs it: BEGIN arms the inherited
 *   session value (`inheritedTransactionTimeoutMs`, 0 = none); inside the
 *   transaction a positive SET arms the timer only when it is INACTIVE (it
 *   never restarts or replaces an active one), and zero disables an active
 *   one; COMMIT/ROLLBACK ends the timer and the next BEGIN sees the inherited
 *   value again. `pg_catalog.pg_settings` reports the current value in ms.
 *   When the timer fires the session terminates: an in-flight statement fails
 *   with SQLSTATE 25P04, later statements / COMMIT / ROLLBACK fail with
 *   "Connection terminated", and the released client is evicted (the next
 *   transaction gets a fresh one);
 * - `set local DateStyle = 'ISO, YMD'` is transaction-local: without it the
 *   session default (e.g. `SQL, DMY`) formats `date::text` columns;
 * - a statement or BEGIN / COMMIT / ROLLBACK can be made to never reply (lost
 *   network: not even the termination arrives) or to fail;
 * - begin / commit / rollback / release are recorded so tests can prove the
 *   connection was cleaned up and no SQL ran after the budget.
 *
 * Real (small) timers are used; margins are generous to stay deterministic.
 */

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';

import type { ProdDatabase } from '@/modules/shared/index.js';

export interface TimedEvent {
  readonly kind:
    | 'acquire'
    | 'begin'
    | 'statement'
    | 'cancelled'
    | 'terminated'
    | 'commit'
    | 'rollback'
    | 'release'
    | 'evicted';
  readonly at: number;
  readonly sql?: string;
}

export interface TimedDriverOptions {
  /** Delay before a connection is handed out (per acquisition, in order). */
  readonly acquireDelays?: readonly number[];
  /** Milliseconds a source statement takes. */
  readonly statementDelay?: (sql: string) => number;
  /** Rows for a statement; `iso` reports whether DateStyle was pinned. */
  readonly respond?: (
    sql: string,
    parameters: readonly unknown[],
    iso: boolean
  ) => readonly unknown[];
  /** The session's DateStyle when not pinned (only `SQL, DMY` is emulated). */
  readonly sessionDateStyle?: 'ISO' | 'SQL, DMY';
  /** Control only: ignore the transaction-local DateStyle pin. */
  readonly ignoreDateStylePin?: boolean;
  /** Delays of the transaction lifecycle replies. */
  readonly beginDelay?: number;
  readonly commitDelay?: number;
  readonly rollbackDelay?: number;
  /** Milliseconds a `set local` setup statement takes. */
  readonly setupDelay?: (sql: string) => number;
  /**
   * Never reply (lost network / stalled server): called with the statement SQL,
   * or `BEGIN` / `COMMIT` / `ROLLBACK`.
   */
  readonly hang?: (sql: string) => boolean;
  /** Fail COMMIT / ROLLBACK with this error. */
  readonly lifecycleError?: (phase: 'COMMIT' | 'ROLLBACK') => Error | undefined;
  /** The session's inherited `transaction_timeout` in ms (0 = none). */
  readonly inheritedTransactionTimeoutMs?: number;
  /** Override the `pg_settings` rows for `transaction_timeout` (current value given). */
  readonly settingsRows?: (setting: string) => readonly unknown[];
}

/** A reply that never arrives. */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentionally never settles
const never = (): Promise<never> => new Promise<never>(() => {});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Date-typed columns the national statements cast with `::text`. */
const DATE_COLUMNS = [
  'period_end',
  'period_start',
  'predecessor_end',
  'release_start',
  'release_end',
];

/** `YYYY-MM-DD` → `DD/MM/YYYY`, as PostgreSQL prints a date under `SQL, DMY`. */
export const toSqlDmy = (rows: readonly unknown[]): unknown[] =>
  rows.map((row) => {
    if (typeof row !== 'object' || row === null) return row;
    const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const column of DATE_COLUMNS) {
      const value = copy[column];
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        copy[column] = `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
      }
    }
    return copy;
  });

export const makeTimedDb = (options: TimedDriverOptions = {}) => {
  const events: TimedEvent[] = [];
  const origin = performance.now();
  const at = (): number => performance.now() - origin;
  let acquisitions = 0;
  let statementTimeout = Number.POSITIVE_INFINITY;
  let iso = options.sessionDateStyle !== 'SQL, DMY';
  let terminated = false;
  const inherited = options.inheritedTransactionTimeoutMs ?? 0;
  // The current transaction_timeout value and its (single) server timer.
  let transactionTimeout = inherited;
  let transactionTimer: ReturnType<typeof setTimeout> | undefined;
  // Rejects the statement in flight when the backstop terminates the session.
  let terminate: ((error: Error) => void) | undefined;
  const connectionLost = (): Error => new Error('Connection terminated unexpectedly');
  const endTransaction = (): void => {
    clearTimeout(transactionTimer);
    transactionTimer = undefined;
  };
  const armTransactionTimer = (ms: number): void => {
    transactionTimer = setTimeout(() => {
      transactionTimer = undefined;
      terminated = true;
      events.push({ kind: 'terminated', at: at() });
      terminate?.(
        Object.assign(new Error('terminating connection due to transaction timeout'), {
          code: '25P04',
        })
      );
    }, ms);
  };

  const execute = async <R>(
    sql: string,
    parameters: readonly unknown[]
  ): Promise<QueryResult<R>> => {
    const setupDelay = sql.startsWith('set local') ? (options.setupDelay?.(sql) ?? 0) : 0;
    if (setupDelay > 0) await sleep(setupDelay);
    const timeout = /^set local statement_timeout = (\d+)$/u.exec(sql);
    if (timeout?.[1] !== undefined) {
      statementTimeout = Number.parseInt(timeout[1], 10);
      return { rows: [] };
    }
    const backstop = /^set local transaction_timeout = (\d+)$/u.exec(sql);
    if (backstop?.[1] !== undefined) {
      // PostgreSQL 18 assign_transaction_timeout: positive arms an INACTIVE
      // timer only; zero disables an active one.
      transactionTimeout = Number.parseInt(backstop[1], 10);
      if (transactionTimeout > 0 && transactionTimer === undefined) {
        armTransactionTimer(transactionTimeout);
      } else if (transactionTimeout === 0) {
        endTransaction();
      }
      return { rows: [] };
    }
    if (sql === "set local DateStyle = 'ISO, YMD'") {
      if (options.ignoreDateStylePin !== true) iso = true;
      return { rows: [] };
    }
    if (sql.startsWith('set local')) return { rows: [] };
    const delay = options.statementDelay?.(sql) ?? 0;
    if (delay > statementTimeout) {
      await sleep(statementTimeout);
      events.push({ kind: 'cancelled', at: at(), sql });
      throw Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      });
    }
    if (delay > 0) await sleep(delay);
    if (sql.includes('pg_catalog.pg_settings')) {
      const setting = String(transactionTimeout);
      return {
        rows: (options.settingsRows?.(setting) ?? [{ setting, unit: 'ms' }]) as R[],
      };
    }
    const rows = options.respond?.(sql, parameters, iso) ?? [];
    return { rows: rows as R[] };
  };

  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const sql = query.sql;
      events.push({ kind: 'statement', at: at(), sql });
      if (terminated) throw connectionLost();
      // Lost network: not even a termination reaches the client.
      if (options.hang?.(sql) === true) return never();
      return new Promise<QueryResult<R>>((resolve, reject) => {
        terminate = reject;
        execute<R>(sql, query.parameters).then(resolve).catch(reject);
      });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported');
    },
  };

  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: async () => {
      const delay = options.acquireDelays?.[acquisitions] ?? 0;
      acquisitions += 1;
      if (delay > 0) await sleep(delay);
      events.push({ kind: 'acquire', at: at() });
      return connection;
    },
    beginTransaction: async () => {
      if (options.hang?.('BEGIN') === true) return never();
      if ((options.beginDelay ?? 0) > 0) await sleep(options.beginDelay ?? 0);
      // An evicted client is replaced: the new transaction gets a fresh session.
      terminated = false;
      endTransaction();
      // SET LOCAL values are gone; BEGIN arms the inherited timer.
      transactionTimeout = inherited;
      if (inherited > 0) armTransactionTimer(inherited);
      statementTimeout = Number.POSITIVE_INFINITY;
      iso = options.sessionDateStyle !== 'SQL, DMY';
      events.push({ kind: 'begin', at: at() });
      return undefined;
    },
    commitTransaction: async () => {
      if (options.hang?.('COMMIT') === true) return never();
      if (terminated) throw connectionLost();
      // The server ends the transaction on receipt; only the reply is delayed.
      endTransaction();
      if ((options.commitDelay ?? 0) > 0) await sleep(options.commitDelay ?? 0);
      const failure = options.lifecycleError?.('COMMIT');
      if (failure !== undefined) throw failure;
      events.push({ kind: 'commit', at: at() });
      return undefined;
    },
    rollbackTransaction: async () => {
      if (options.hang?.('ROLLBACK') === true) return never();
      if (terminated) throw connectionLost();
      // The server ends the transaction on receipt; only the reply is delayed.
      endTransaction();
      if ((options.rollbackDelay ?? 0) > 0) await sleep(options.rollbackDelay ?? 0);
      const failure = options.lifecycleError?.('ROLLBACK');
      if (failure !== undefined) throw failure;
      events.push({ kind: 'rollback', at: at() });
      return undefined;
    },
    releaseConnection: () => {
      // pg-pool evicts a client that can no longer be queried.
      events.push({ kind: terminated ? 'evicted' : 'release', at: at() });
      return Promise.resolve();
    },
    destroy: () => Promise.resolve(),
  };

  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, events, elapsed: at };
};
