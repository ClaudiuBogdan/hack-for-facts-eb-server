import { type Clock } from '@/common/ports/clock.js';

const DEFAULT_START_MS = new Date('2024-01-01T00:00:00.000Z').getTime();

export interface TestClock extends Clock {
  /** Move time forward by ms. Returns the new current Date. */
  advance(ms: number): Date;
  /** Jump to an absolute instant. */
  set(date: Date): void;
}

/** Clock frozen at start; convenience wrapper over makeTestClock. */
export function makeFixedClock(start: Date): Clock {
  return makeTestClock(start);
}

/** Controllable clock; defaults to 2024-01-01T00:00:00.000Z. */
export function makeTestClock(start: Date = new Date(DEFAULT_START_MS)): TestClock {
  let currentMs = start.getTime();

  return {
    now: (): Date => new Date(currentMs),
    advance: (ms: number): Date => {
      currentMs += ms;
      return new Date(currentMs);
    },
    set: (date: Date): void => {
      currentMs = date.getTime();
    },
  };
}
