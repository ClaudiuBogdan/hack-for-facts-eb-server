/**
 * National budget — the one-transaction read port and its response cache.
 *
 * Every national root runs inside ONE read-only repeatable-read transaction:
 * the lane token, the plan inputs and every projected row come from the same
 * snapshot. One read budget bounds the root (5 s, 15 s for the national
 * series), measured from the moment the read is requested; a successful result
 * is always produced within it.
 *
 * Kysely enters the transaction callback only after pool checkout AND BEGIN.
 * Inside it one guard (abandoned, or under 1 ms left → deadline exceeded) runs
 * before and after every awaited step, so no setup or source statement starts
 * after expiry:
 * - first the inherited `transaction_timeout` (PostgreSQL ≥ 17) is read, in
 *   milliseconds, before anything changes it. A positive inherited limit is a
 *   stricter cap that is kept, never extended: it is anchored at the READ START
 *   (conservative: checkout and BEGIN come later), so the effective read
 *   deadline is min(start + budget, start + inherited) and the effective
 *   server backstop min(start + budget + grace, start + inherited). A missing
 *   or malformed setting fails closed (`ServiceUnavailable`);
 * - PostgreSQL 18 only arms an INACTIVE transaction timer on a positive SET
 *   and disables an active one on zero, so `SET LOCAL transaction_timeout = 0`
 *   then the strictly positive time left to the effective backstop replaces
 *   whatever timer BEGIN armed. No source work starts before that positive SET
 *   is acknowledged. The session terminates once it passes, and the kernel
 *   pool evicts that client on release; COMMIT/ROLLBACK restores the inherited
 *   value (SET LOCAL);
 * - then `DateStyle` is pinned to ISO, so every `date::text` is `YYYY-MM-DD`
 *   whatever the session default is;
 * - each source statement first gets `statement_timeout` = the remaining
 *   read budget (PostgreSQL cancels server-side; the transaction rolls back
 *   and the connection stays usable), and the guard runs again after that
 *   round trip;
 * - work or a COMMIT that finishes at or after the effective read deadline is
 *   `Timeout` (late work rolls back instead of committing).
 *
 * The caller's timeout allowance is longer than the read budget. If checkout
 * and BEGIN have not both completed by the deadline, the caller gets `Timeout`
 * at the deadline; otherwise the port waits for settlement up to the effective
 * backstop + cleanup margin (at most 6.25 s / 16.25 s). Returning `Timeout`
 * only ends the caller's wait: a late transaction start that reaches the
 * callback runs no source SQL and is rolled back and released by the driver
 * lifecycle, and the settlement is observed if and when it happens.
 *
 * Limitation (a shared-kernel one, documented, not solved here): when checkout,
 * BEGIN, the setting read, a SET, COMMIT/ROLLBACK or the socket itself never
 * settles, this port cannot cancel a queued pool waiter, destroy the
 * checked-out client or make the step settle; it holds only an abandoned
 * pending promise and an observer. Before the reset, setup is protected by
 * the inherited timer (if any); between the zero SET and the acknowledged
 * positive SET only the pool's session `statement_timeout` and the client
 * guard apply. Through the kernel's Kysely instance the port has no access to the pg
 * client, and the kernel pool sets no TCP keep-alive or client query timeout.
 *
 * Errors: a cancelled or terminated statement (57014 / 25P04), or any failure
 * once the effective read deadline has passed, is `Timeout`; a generic
 * connection failure before it stays `Database`. A missing relation/grant, an
 * unknown stored literal or a missing/malformed `transaction_timeout` setting
 * is `ServiceUnavailable`; anything else is a static `Database` error whose
 * driver text stays in `cause`.
 */

import { sql, type Kysely, type QueryResult, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  createCache,
  databaseError,
  serviceUnavailable,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type {
  NationalCacheStamp,
  NationalReadOptions,
  NationalReadPort,
  NationalReadTx,
  NationalResponseCache,
} from '../../core/national/ports.js';

/** Runs one source statement inside the root's transaction, under the remaining budget. */
export type NationalRun = <R>(statement: RawBuilder<R>) => Promise<QueryResult<R>>;

/** A stored value outside the reviewed source vocabulary or shape. */
export class NationalSourceContractError extends Error {
  override readonly name = 'NationalSourceContractError';
}

/** The server lacks a capability the port requires (e.g. `transaction_timeout`). */
export class NationalServerCapabilityError extends Error {
  override readonly name = 'NationalServerCapabilityError';
}

/** The root's single read budget is spent. */
export class NationalDeadlineExceeded extends Error {
  override readonly name = 'NationalDeadlineExceeded';
}

const UNAVAILABLE_CODES = new Set(['42P01', '42703', '42883', '42501', '3F000']);

/** `query_canceled` (statement_timeout) and `transaction_timeout`. */
const TIMEOUT_CODES = new Set(['57014', '25P04']);

const codeOf = (cause: unknown): string => {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
};

const isTimeout = (cause: unknown): boolean =>
  cause instanceof NationalDeadlineExceeded ||
  TIMEOUT_CODES.has(codeOf(cause)) ||
  (cause instanceof Error &&
    (cause.message.includes('statement timeout') ||
      cause.message.includes('transaction timeout') ||
      // pg-pool's own acquisition timeout
      cause.message.includes('timeout exceeded when trying to connect')));

/**
 * Map an adapter failure. `budgetSpent` makes any failure after the deadline
 * a `Timeout` (e.g. a ROLLBACK on a session the backstop terminated).
 */
export const nationalDbError = (
  cause: unknown,
  operation: string,
  budgetSpent = false
): ApiError => {
  if (cause instanceof NationalSourceContractError) {
    return serviceUnavailable(`national budget source contract violated: ${cause.message}`);
  }
  if (cause instanceof NationalServerCapabilityError) {
    return serviceUnavailable(`national budget server capability unavailable: ${cause.message}`);
  }
  if (budgetSpent || isTimeout(cause)) return timeoutError(`${operation} timed out`);
  if (UNAVAILABLE_CODES.has(codeOf(cause))) {
    return serviceUnavailable('national budget serving relations are unavailable');
  }
  return databaseError(`${operation} failed`, cause);
};

/** Run one adapter read and map any failure to an `ApiError`. */
export const guardedRead = async <T>(
  operation: string,
  run: () => Promise<T>
): Promise<Result<T, ApiError>> => {
  try {
    return ok(await run());
  } catch (cause) {
    return err(nationalDbError(cause, operation));
  }
};

/** The inherited `transaction_timeout`, read before the port changes it. */
export const INHERITED_TRANSACTION_TIMEOUT_SQL = sql<{ setting: unknown; unit: unknown }>`
  /* budget.national:inherited_transaction_timeout */
  select setting, unit from pg_catalog.pg_settings where name = 'transaction_timeout'
`;

/** PostgreSQL's upper bound for an integer millisecond setting. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The inherited `transaction_timeout` in milliseconds (0 = no limit). Exactly
 * one row with a canonical non-negative integer `setting` in `ms`; anything
 * else (absent before PostgreSQL 17, another unit, a malformed value) fails
 * closed.
 */
export const parseInheritedTransactionTimeout = (rows: readonly unknown[]): number => {
  const row = rows.length === 1 ? rows[0] : undefined;
  const setting = (row as { setting?: unknown } | undefined)?.setting;
  const unit = (row as { unit?: unknown } | undefined)?.unit;
  if (typeof setting !== 'string' || unit !== 'ms' || !/^(0|[1-9]\d{0,9})$/u.test(setting)) {
    throw new NationalServerCapabilityError('transaction_timeout setting missing or malformed');
  }
  const ms = Number(setting);
  if (ms > MAX_TIMEOUT_MS) {
    throw new NationalServerCapabilityError('transaction_timeout setting out of range');
  }
  return ms;
};

/** Builds the two lane readers over one open transaction (composed in the module). */
export type NationalReaders = (run: NationalRun) => NationalReadTx;

/**
 * Why the port stopped waiting: `transaction-start` — pool checkout and BEGIN
 * had not both completed by the deadline (a queued waiter or a stalled BEGIN);
 * `stalled` — the transaction had not settled by the hard bound.
 */
export type NationalAbandonPhase = 'transaction-start' | 'stalled';

/**
 * A read the caller already got `Timeout` for. Reported as `abandoned` at once
 * when the port stops waiting, and as `settled` if and when the driver settles
 * (never, for a lifecycle step that does not settle). A report is a diagnostic,
 * not proof of cleanup.
 */
export type NationalAbandonedRead =
  | {
      readonly stage: 'abandoned';
      readonly operation: string;
      readonly phase: NationalAbandonPhase;
    }
  | {
      readonly stage: 'settled';
      readonly operation: string;
      readonly phase: NationalAbandonPhase;
      readonly outcome: 'committed' | 'rolled-back-or-failed';
    };

export interface NationalReadPortOptions {
  /** Monotonic milliseconds (tests inject a controllable clock). */
  readonly clock?: () => number;
  /** `transaction_timeout` backstop margin above the remaining budget (≥ 0). */
  readonly transactionGraceMs?: number;
  /** Best-effort diagnostics for abandoned reads; an observer that throws is ignored. */
  readonly onAbandoned?: (read: NationalAbandonedRead) => void;
}

/** Server-side backstop margin; well above a statement round trip. */
export const NATIONAL_TRANSACTION_GRACE_MS = 1_000;

/**
 * Client-side margin past the effective backstop before the port stops
 * waiting, so the timeout allowance is at most budget + grace + margin
 * (6.25 s / 16.25 s), less under a stricter inherited limit. It bounds the
 * caller's wait only; it does not prove the backend stopped or the client was
 * reclaimed.
 */
export const NATIONAL_CLEANUP_MARGIN_MS = 250;

type Outcome<T> =
  | { readonly kind: 'done'; readonly value: Result<T, ApiError> }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** `start`: pool checkout and BEGIN (Kysely enters the callback after both). */
type Phase = 'start' | 'callback' | 'finish';

export const makeNationalReadPort = (
  db: Kysely<ProdDatabase>,
  readers: NationalReaders,
  options: NationalReadPortOptions = {}
): NationalReadPort => {
  const now = options.clock ?? (() => performance.now());
  const grace = Math.max(0, options.transactionGraceMs ?? NATIONAL_TRANSACTION_GRACE_MS);
  /** Diagnostics are best-effort: an observer failure never reaches the caller. */
  const observe = (read: NationalAbandonedRead): void => {
    try {
      options.onAbandoned?.(read);
    } catch {
      // Ignored: the request has its answer already.
    }
  };
  return {
    async read<T>(
      work: (tx: NationalReadTx) => Promise<Result<T, ApiError>>,
      { deadlineMs, operation }: NationalReadOptions
    ): Promise<Result<T, ApiError>> {
      const started = now();
      // Effective deadlines, tightened by a positive inherited transaction_timeout.
      let readDeadline = started + deadlineMs;
      let backstopDeadline = readDeadline + grace;
      const remaining = (): number => Math.floor(readDeadline - now());
      const expired = (): boolean => remaining() <= 0;
      // Shared with the transaction callback.
      const state: {
        phase: Phase;
        abandoned: boolean;
        timedOut: boolean;
        callbackFailed: boolean;
        callbackError: unknown;
      } = {
        phase: 'start',
        abandoned: false,
        timedOut: false,
        callbackFailed: false,
        callbackError: undefined,
      };
      const deadlineExceeded = (message: string, cause?: unknown): NationalDeadlineExceeded => {
        state.timedOut = true;
        return new NationalDeadlineExceeded(message, cause === undefined ? undefined : { cause });
      };
      /** The one budget guard: the whole milliseconds left (≥ 1), or throw. */
      const guard = (step: string): number => {
        const left = remaining();
        if (state.abandoned || left <= 0) {
          throw deadlineExceeded(`${operation} budget spent ${step}`);
        }
        return left;
      };

      let stop: (phase: NationalAbandonPhase) => void = () => undefined;
      const stopped = new Promise<NationalAbandonPhase>((resolve) => {
        stop = resolve;
      });
      // Not settled by the effective backstop + margin: stop waiting. This ends
      // the caller's wait only; the transaction may still be pending.
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleHardTimer = (): void => {
        clearTimeout(hardTimer);
        hardTimer = setTimeout(
          () => {
            state.abandoned = true;
            stop('stalled');
          },
          // One absolute bound: never a fresh margin after the backstop passed.
          Math.max(0, backstopDeadline + NATIONAL_CLEANUP_MARGIN_MS - now())
        );
      };

      const transaction = db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (trx) => {
          state.phase = 'callback';
          try {
            // A late (or abandoned) checkout/BEGIN runs no SQL and rolls back.
            guard('at transaction start');
            const { rows } = await INHERITED_TRANSACTION_TIMEOUT_SQL.execute(trx);
            guard('after reading the inherited transaction timeout');
            const inherited = parseInheritedTransactionTimeout(rows);
            if (inherited > 0) {
              // Kept, never extended: anchored at the read start, no grace past it.
              readDeadline = Math.min(readDeadline, started + inherited);
              backstopDeadline = Math.min(backstopDeadline, started + inherited);
              scheduleHardTimer();
            }
            // Already spent under the inherited cap: roll back, no reset.
            guard('under the inherited transaction timeout');
            // Zero disables the timer BEGIN armed; the positive SET re-arms it.
            await sql`set local transaction_timeout = 0`.execute(trx);
            guard('after the backstop reset');
            const backstop = Math.floor(backstopDeadline - now());
            if (backstop <= 0) throw deadlineExceeded(`${operation} backstop spent`);
            await sql`set local transaction_timeout = ${sql.lit(backstop)}`.execute(trx);
            guard('after the backstop setup');
            await sql`set local DateStyle = 'ISO, YMD'`.execute(trx);
            guard('after the DateStyle setup');
            const run: NationalRun = async (statement) => {
              const budget = guard('before a statement timeout setup');
              await sql`set local statement_timeout = ${sql.lit(budget)}`.execute(trx);
              // The setup round trip may itself have spent the budget.
              guard('before a source statement');
              try {
                return await statement.execute(trx);
              } catch (cause) {
                if (expired() || isTimeout(cause)) {
                  throw deadlineExceeded(`${operation} budget spent`, cause);
                }
                throw cause;
              }
            };
            const result = await work(readers(run));
            // Projection after the last statement may also spend the budget:
            // roll back instead of committing a late answer.
            guard('after the work');
            state.phase = 'finish';
            return result;
          } catch (cause) {
            state.callbackFailed = true;
            state.callbackError = cause;
            throw cause;
          }
        });

      const settled: Promise<Outcome<T>> = transaction.then(
        (value) => ({ kind: 'done', value }),
        (cause: unknown) => ({ kind: 'failed', cause })
      );
      // Checkout and BEGIN not both done by the deadline: stop waiting.
      const startTimer = setTimeout(
        () => {
          if (state.phase !== 'start') return;
          state.abandoned = true;
          stop('transaction-start');
        },
        Math.max(0, remaining())
      );
      scheduleHardTimer();
      const first = await Promise.race([settled, stopped]);
      clearTimeout(startTimer);
      clearTimeout(hardTimer);

      if (typeof first === 'string') {
        observe({ stage: 'abandoned', operation, phase: first });
        // `settled` never rejects and `observe` never throws: nothing unhandled.
        void settled.then((outcome) => {
          observe({
            stage: 'settled',
            operation,
            phase: first,
            outcome: outcome.kind === 'done' ? 'committed' : 'rolled-back-or-failed',
          });
          return undefined;
        });
        return err(
          timeoutError(
            first === 'transaction-start'
              ? `${operation} timed out before checkout/transaction start completed`
              : `${operation} timed out`
          )
        );
      }
      if (first.kind === 'failed') {
        if (state.callbackFailed) {
          // Kysely rethrows a failing ROLLBACK in place of the callback's error:
          // map the original failure (source semantics preserved).
          return err(nationalDbError(state.callbackError, operation, state.timedOut || expired()));
        }
        // Checkout/BEGIN, or COMMIT/ROLLBACK after the work: a timeout only with
        // timeout evidence or once the effective read deadline has passed.
        return err(nationalDbError(first.cause, operation, expired()));
      }
      // Work or a COMMIT that completed at or after the deadline is a timeout.
      return expired() ? err(timeoutError(`${operation} timed out`)) : first.value;
    },
  };
};

/** Bounded staleness of a lane probe (design §6). */
export const NATIONAL_PROBE_TTL_MS = 30_000;

/** Hard upper bounds of the national response cache (configurable only downward). */
export const NATIONAL_CACHE_MAX_RESPONSES = 64;
/** Largest complete public payload admitted, in UTF-8 JSON bytes (256 KiB). */
export const NATIONAL_CACHE_MAX_RESPONSE_BYTES = 262_144;
/** Response time-to-live (unchanged); the entry and size caps bound retention. */
export const NATIONAL_CACHE_RESPONSE_TTL_MS = 15 * 60_000;

interface ProbeEntry {
  readonly snapshot: string;
  readonly stamp: NationalCacheStamp;
}

const isProbeEntry = (value: unknown): value is ProbeEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { snapshot?: unknown }).snapshot === 'string' &&
  typeof (value as { stamp?: { at?: unknown } }).stamp?.at === 'number';

export interface NationalResponseCacheOptions {
  readonly responseTtlMs?: number;
  /** At most `NATIONAL_CACHE_MAX_RESPONSES`; larger values are clamped. */
  readonly maxResponses?: number;
  /** At most `NATIONAL_CACHE_MAX_RESPONSE_BYTES`; larger values are clamped. */
  readonly maxResponseBytes?: number;
  /** Milliseconds (tests inject a controllable clock). */
  readonly clock?: () => number;
}

/** UTF-8 JSON size of a complete payload, or null when it cannot be serialised. */
const jsonBytes = (value: unknown): number | null => {
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined ? null : Buffer.byteLength(json, 'utf8');
  } catch {
    return null;
  }
};

const capped = (value: number | undefined, max: number): number =>
  value === undefined || !Number.isFinite(value)
    ? max
    : Math.max(1, Math.min(Math.floor(value), max));

/**
 * The national response cache over the kernel cache primitive.
 *
 * Freshness is measured from the READ START stamp (conservative: the snapshot
 * is observed at or after it), never from completion. A probe is usable only
 * while `now − stamp < 30 s`; a computation that consumed the window is not
 * remembered; an older read never replaces the probe of a newer read (start
 * order, which also orders equal-millisecond starts).
 *
 * Responses are keyed by canonical arguments AND snapshot, so a payload is
 * only replayed for the snapshot it was computed in (never a source replay).
 * At most 64 responses are retained (the kernel cache's insertion-order
 * eviction), and only complete payloads of at most 256 KiB of UTF-8 JSON are
 * admitted: a larger one is simply not stored — the result is unchanged, no
 * admitted entry is evicted, and no serialised copy is kept. That bounds the
 * retained serialised payload to 16 MiB; it is not a heap/RSS bound and does
 * not limit responses being built concurrently.
 */
export const makeNationalResponseCache = (
  options: NationalResponseCacheOptions = {}
): NationalResponseCache => {
  const clock = options.clock ?? (() => Date.now());
  const maxBytes = capped(options.maxResponseBytes, NATIONAL_CACHE_MAX_RESPONSE_BYTES);
  let order = 0;
  const probes = createCache({ ttlMs: NATIONAL_PROBE_TTL_MS, maxEntries: 8 });
  const responses = createCache({
    ttlMs: options.responseTtlMs ?? NATIONAL_CACHE_RESPONSE_TTL_MS,
    maxEntries: capped(options.maxResponses, NATIONAL_CACHE_MAX_RESPONSES),
  });
  const fresh = (stamp: NationalCacheStamp): boolean => clock() - stamp.at < NATIONAL_PROBE_TTL_MS;
  const current = (lane: string): ProbeEntry | undefined => {
    const value = probes.get(lane);
    return isProbeEntry(value) ? value : undefined;
  };
  return {
    begin: () => {
      order += 1;
      return { at: clock(), order };
    },
    probe: (lane) => {
      const entry = current(lane);
      return entry !== undefined && fresh(entry.stamp) ? entry.snapshot : undefined;
    },
    remember: (lane, snapshot, stamp) => {
      if (!fresh(stamp)) return;
      const existing = current(lane);
      if (existing !== undefined && existing.stamp.order > stamp.order) return;
      probes.set(lane, { snapshot, stamp });
    },
    get: (key) => responses.get(key),
    set: (key, value, stamp) => {
      if (!fresh(stamp)) return;
      const bytes = jsonBytes(value);
      // Oversized or unserialisable: skip before the kernel cache can evict anything.
      if (bytes === null || bytes > maxBytes) return;
      responses.set(key, value);
    },
  };
};
