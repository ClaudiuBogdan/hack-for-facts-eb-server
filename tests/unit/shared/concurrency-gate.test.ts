/**
 * The kernel concurrency gate: at most N holders, a bounded FIFO queue, a
 * wait timeout, idempotent release and a close that refuses everyone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeConcurrencyGate } from '@/modules/shared/index.js';

afterEach(() => {
  vi.useRealTimers();
});

const gateOf = (maxConcurrent: number, maxQueued: number, queueWaitMs = 1_000) =>
  makeConcurrencyGate({ maxConcurrent, maxQueued, queueWaitMs });

describe('concurrency gate', () => {
  it('grants N at once; the (N+1)-th waits and runs when a slot is released', async () => {
    const gate = gateOf(2, 4);
    const first = (await gate.acquire())._unsafeUnwrap();
    (await gate.acquire())._unsafeUnwrap();
    let third: boolean | undefined;
    const pending = gate.acquire().then((r) => (third = r.isOk()));
    await Promise.resolve();
    expect(third).toBeUndefined();
    expect(gate.stats()).toEqual({ active: 2, queued: 1 });
    first.release();
    await pending;
    expect(third).toBe(true);
    // The waiter took the released slot: still 2 holders, nobody queued.
    expect(gate.stats()).toEqual({ active: 2, queued: 0 });
  });

  it('serves waiters in arrival order', async () => {
    const gate = gateOf(1, 4);
    const holder = (await gate.acquire())._unsafeUnwrap();
    const order: string[] = [];
    const a = gate.acquire().then((r) => {
      order.push('a');
      return r._unsafeUnwrap();
    });
    const b = gate.acquire().then((r) => {
      order.push('b');
      return r._unsafeUnwrap();
    });
    holder.release();
    (await a).release();
    (await b).release();
    expect(order).toEqual(['a', 'b']);
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('refuses at once when the queue is full', async () => {
    const gate = gateOf(1, 1);
    (await gate.acquire())._unsafeUnwrap();
    void gate.acquire();
    expect((await gate.acquire())._unsafeUnwrapErr()).toBe('queue_full');
  });

  it('refuses a waiter after the wait timeout and drops it from the queue', async () => {
    vi.useFakeTimers();
    const gate = gateOf(1, 4, 500);
    const holder = (await gate.acquire())._unsafeUnwrap();
    const waiting = gate.acquire();
    await vi.advanceTimersByTimeAsync(500);
    expect((await waiting)._unsafeUnwrapErr()).toBe('wait_timeout');
    expect(gate.stats()).toEqual({ active: 1, queued: 0 });
    holder.release();
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('refuses a waiter whose deadline passed before a release hands it the slot', async () => {
    const clock = { t: 0 };
    const gate = makeConcurrencyGate(
      { maxConcurrent: 1, maxQueued: 4, queueWaitMs: 100 },
      () => clock.t
    );
    const holder = (await gate.acquire())._unsafeUnwrap();
    const late = gate.acquire();
    clock.t = 50;
    const onTime = gate.acquire();
    // Past the first waiter's deadline, before its timer runs.
    clock.t = 101;
    holder.release();
    expect((await late)._unsafeUnwrapErr()).toBe('wait_timeout');
    expect((await onTime)._unsafeUnwrap().waitedMs).toBe(51);
    expect(gate.stats()).toEqual({ active: 1, queued: 0 });
  });

  it('a close from inside the clock during a handoff still refuses the waiter', async () => {
    const clock = { t: 0, onRead: undefined as (() => void) | undefined };
    const gate = makeConcurrencyGate({ maxConcurrent: 1, maxQueued: 4, queueWaitMs: 100 }, () => {
      clock.onRead?.();
      return clock.t;
    });
    const holder = (await gate.acquire())._unsafeUnwrap();
    const waiting = gate.acquire();
    clock.onRead = () => {
      clock.onRead = undefined;
      gate.close();
    };
    holder.release();
    expect((await waiting)._unsafeUnwrapErr()).toBe('closed');
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('a double release frees one slot only', async () => {
    const gate = gateOf(1, 4);
    const holder = (await gate.acquire())._unsafeUnwrap();
    const next = gate.acquire();
    holder.release();
    holder.release();
    (await next)._unsafeUnwrap();
    expect(gate.stats()).toEqual({ active: 1, queued: 0 });
  });

  it('close refuses the waiters and every later caller', async () => {
    const gate = gateOf(1, 4);
    (await gate.acquire())._unsafeUnwrap();
    const waiting = gate.acquire();
    gate.close();
    expect((await waiting)._unsafeUnwrapErr()).toBe('closed');
    expect((await gate.acquire())._unsafeUnwrapErr()).toBe('closed');
  });
});
