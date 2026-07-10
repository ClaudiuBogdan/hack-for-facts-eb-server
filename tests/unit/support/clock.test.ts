import { describe, expect, it } from 'vitest';

import { makeFixedClock, makeTestClock } from '../../support/index.js';

describe('test clocks', () => {
  it('defaults to the documented instant and returns a fresh Date on every read', () => {
    const clock = makeTestClock();

    const first = clock.now();
    const second = clock.now();

    expect(first).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(first).not.toBe(second);
    first.setUTCFullYear(2030);
    expect(clock.now()).toEqual(new Date('2024-01-01T00:00:00.000Z'));
  });

  it('advances deterministically and does not alias the returned Date', () => {
    const clock = makeTestClock(new Date('2025-02-03T04:05:06.000Z'));

    const advanced = clock.advance(1_500);
    expect(advanced).toEqual(new Date('2025-02-03T04:05:07.500Z'));

    advanced.setTime(0);
    expect(clock.now()).toEqual(new Date('2025-02-03T04:05:07.500Z'));
  });

  it('sets an absolute instant without retaining the caller Date', () => {
    const clock = makeTestClock();
    const target = new Date('2027-08-09T10:11:12.000Z');

    clock.set(target);
    target.setTime(0);

    expect(clock.now()).toEqual(new Date('2027-08-09T10:11:12.000Z'));
  });

  it('provides a fixed Clock with fresh Date reads', () => {
    const clock = makeFixedClock(new Date('2026-01-02T03:04:05.000Z'));

    expect(clock.now()).toEqual(new Date('2026-01-02T03:04:05.000Z'));
    expect(clock.now()).not.toBe(clock.now());
  });
});
