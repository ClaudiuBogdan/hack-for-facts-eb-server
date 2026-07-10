import { describe, expect, it } from 'vitest';

import { computeDigestWindow } from '@/modules/notification-platform/core/digest/windowing.js';

const expectIsoWindow = (
  cadence: 'daily' | 'weekly',
  at: string,
  expectedStart: string,
  expectedEnd: string
): void => {
  const window = computeDigestWindow(cadence, new Date(at));
  expect(window.windowStartUtc.toISOString()).toBe(expectedStart);
  expect(window.windowEndUtc.toISOString()).toBe(expectedEnd);
  expect(window.dispatchAtUtc.toISOString()).toBe(expectedEnd);
};

describe('computeDigestWindow', () => {
  it.each([
    [
      '2026 spring forward',
      '2026-03-29T04:00:00.000Z',
      '2026-03-28T06:00:00.000Z',
      '2026-03-29T05:00:00.000Z',
    ],
    [
      '2026 fall back',
      '2026-10-25T04:00:00.000Z',
      '2026-10-24T05:00:00.000Z',
      '2026-10-25T06:00:00.000Z',
    ],
    [
      '2027 spring forward',
      '2027-03-28T04:00:00.000Z',
      '2027-03-27T06:00:00.000Z',
      '2027-03-28T05:00:00.000Z',
    ],
    [
      '2027 fall back',
      '2027-10-31T04:00:00.000Z',
      '2027-10-30T05:00:00.000Z',
      '2027-10-31T06:00:00.000Z',
    ],
  ] as const)('uses local 08:00 boundaries on %s', (_name, at, start, end) => {
    expectIsoWindow('daily', at, start, end);
  });

  it.each([
    [
      'ordinary winter day',
      '2026-02-10T12:00:00.000Z',
      '2026-02-10T06:00:00.000Z',
      '2026-02-11T06:00:00.000Z',
    ],
    [
      'ordinary summer day',
      '2026-07-10T12:00:00.000Z',
      '2026-07-10T05:00:00.000Z',
      '2026-07-11T05:00:00.000Z',
    ],
  ] as const)('computes the %s', (_name, at, start, end) => {
    expectIsoWindow('daily', at, start, end);
  });

  it('uses Monday 08:00 Europe/Bucharest for weekly windows', () => {
    expectIsoWindow(
      'weekly',
      '2026-04-02T12:00:00.000Z',
      '2026-03-30T05:00:00.000Z',
      '2026-04-06T05:00:00.000Z'
    );
  });

  it('keeps a Monday instant before 08:00 in the preceding weekly window', () => {
    expectIsoWindow(
      'weekly',
      '2026-03-30T04:59:59.000Z',
      '2026-03-23T06:00:00.000Z',
      '2026-03-30T05:00:00.000Z'
    );
  });

  it.each([
    ['2026-03-28T12:00:00.000Z'],
    ['2026-10-24T12:00:00.000Z'],
    ['2027-03-27T12:00:00.000Z'],
    ['2027-10-30T12:00:00.000Z'],
  ])('tiles daily windows without gaps or overlaps across %s', (at) => {
    const first = computeDigestWindow('daily', new Date(at));
    const second = computeDigestWindow('daily', first.windowEndUtc);
    const third = computeDigestWindow('daily', second.windowEndUtc);

    expect(second.windowStartUtc.getTime()).toBe(first.windowEndUtc.getTime());
    expect(third.windowStartUtc.getTime()).toBe(second.windowEndUtc.getTime());
    expect(first.dispatchAtUtc.getTime()).toBe(first.windowEndUtc.getTime());
    expect(second.dispatchAtUtc.getTime()).toBe(second.windowEndUtc.getTime());
  });
});
