/**
 * Shared Kernel — a per-process concurrency gate for an upstream with a hard
 * server-side limit on concurrent queries (e.g. a ClickHouse user's
 * `max_concurrent_queries_for_user`).
 *
 * At most `maxConcurrent` holders at once. Callers over the cap wait in a FIFO
 * queue of at most `maxQueued`; a caller that finds the queue full, or waits
 * longer than `queueWaitMs`, is refused at once rather than sent upstream to be
 * refused there. Releasing hands the slot straight to the next waiter.
 */

import { err, ok, type Result } from 'neverthrow';

export interface ConcurrencyGateOptions {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly queueWaitMs: number;
}

/** Why the gate refused a caller. */
export type GateRefusal = 'queue_full' | 'wait_timeout' | 'closed';

export interface GateTicket {
  /** Milliseconds spent queued before the slot was granted (0 when immediate). */
  readonly waitedMs: number;
  /** Return the slot. Idempotent. */
  release(): void;
}

export interface ConcurrencyGate {
  acquire(): Promise<Result<GateTicket, GateRefusal>>;
  /** Current holders and waiters (for logs). */
  stats(): { readonly active: number; readonly queued: number };
  /** Refuse every waiter and every later caller. */
  close(): void;
}

interface Waiter {
  /** true: granted the releasing holder's slot; false: the gate closed. */
  settle(granted: boolean): void;
}

export const makeConcurrencyGate = (
  options: ConcurrencyGateOptions,
  now: () => number = () => performance.now()
): ConcurrencyGate => {
  let active = 0;
  let closed = false;
  const queue: Waiter[] = [];

  const releaseSlot = (): void => {
    const next = queue.shift();
    if (next !== undefined) next.settle(true);
    else active--;
  };

  const ticket = (waitedMs: number): GateTicket => {
    let released = false;
    return {
      waitedMs,
      release() {
        if (released) return;
        released = true;
        releaseSlot();
      },
    };
  };

  return {
    acquire() {
      if (closed) return Promise.resolve(err('closed' as const));
      if (active < options.maxConcurrent) {
        active++;
        return Promise.resolve(ok(ticket(0)));
      }
      if (queue.length >= options.maxQueued) return Promise.resolve(err('queue_full' as const));
      const startedAt = now();
      return new Promise((resolve) => {
        const waiter: Waiter = {
          settle(granted) {
            clearTimeout(timer);
            // A granted waiter inherits the releasing holder's slot (`active` unchanged).
            resolve(granted ? ok(ticket(Math.round(now() - startedAt))) : err('closed'));
          },
        };
        const timer = setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          resolve(err('wait_timeout'));
        }, options.queueWaitMs);
        queue.push(waiter);
      });
    },
    stats: () => ({ active, queued: queue.length }),
    close() {
      closed = true;
      for (const waiter of queue.splice(0)) waiter.settle(false);
    },
  };
};
