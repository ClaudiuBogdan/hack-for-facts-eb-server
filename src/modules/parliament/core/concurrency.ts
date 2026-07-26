/**
 * Parliament core — a bounded-concurrency gate for the dossier child fan-out.
 *
 * Incident 2026-07-26: `/parlament/proiecte/23135` rendered the client's API-error
 * state because `parliamentBill(billKey:"23135")` failed inside ROTATING dossier
 * children (`getBillDocuments` / `getBillEvents` / `getBillVoteLinks`) with
 * PostgreSQL `FATAL: too many connections for role
 * transparenta_prod_agent_readonly`. Bill 23135 is a RESOLVED CDep/Senate pair, so
 * `getBillDossier` fanned 2 views × 6 child families through nested `Promise.all` —
 * 12 simultaneous statements from ONE request, against a server pool of max 15 and a
 * managed role shared by every reader. Any aborted child aborts the whole dossier
 * `Result`, which is why the failure rotated between families and nulled the page.
 *
 * The gate throttles only when a task STARTS. It never changes what a task returns,
 * the order results are assembled in, or which error wins — callers keep their
 * `Promise.all` tuple shape and full type inference.
 */

/** Runs at most `limit` tasks at a time; resolves/rejects exactly like `task()`. */
export type ConcurrencyGate = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Max simultaneous child repo reads for ONE dossier assembly (12 statements before
 * this bound; 6 for a single-view bill). Chosen well under the production pool
 * (`max: 15`) so a single dossier can never monopolise it, and low enough that N
 * concurrent dossier requests degrade in LATENCY instead of exhausting the managed
 * role's connection limit. MUST stay ≤ 4 — raising it re-opens the 2026-07-26
 * incident. Measured against the prod pool + CNPG role limit; re-validate if either
 * changes.
 */
export const DOSSIER_CHILD_READ_CONCURRENCY = 4;

/**
 * A minimal FIFO semaphore. No dependency, no timers, no cancellation: a permit is
 * claimed before the task runs and handed to the next waiter in `finally`, so the
 * in-flight count never exceeds `limit` even transiently.
 */
export const makeConcurrencyGate = (limit: number): ConcurrencyGate => {
  // Invalid/non-finite limits would deadlock or silently remove the ceiling. Core
  // must not throw, so fail closed to one permit.
  const truncated = Math.trunc(limit);
  const permits = Number.isFinite(truncated) && truncated >= 1 ? truncated : 1;
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (active < permits) {
      active += 1; // no await between the test and the claim → no overshoot window
      return;
    }
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
    // `release` handed its permit over directly; `active` was never decremented.
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      active -= 1;
      return;
    }
    // Hand the permit straight to the next waiter: decrementing first would let a
    // fresh `acquire` slip through the gap and push the in-flight count over `limit`.
    next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};
