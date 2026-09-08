import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { singleYearMoneyFactor } from '@/modules/budget/shell/repo/money-factor.js';

import type { FactorSource } from '@/modules/budget/core/legacy-analytics/ports.js';

const OracleDecimal = Decimal.clone({ precision: 80 });

const source: FactorSource = {
  yearly: async (kind) =>
    ok(
      new Map(
        (kind === 'ron_per_eur'
          ? [
              [2024, '4.9746'],
              [2025, '5.0415'],
            ]
          : [
              [2024, '1759183300000'],
              [2025, '1916404900000'],
            ]
        ).map(([year, value]) => [Number(year), new Decimal(value!)])
      )
    ),
};

describe('native single-year money factor', () => {
  it.each(['TOTAL_EURO', 'PER_CAPITA_EURO', 'PERCENT_GDP'] as const)(
    'uses independent exact 2025 source values for %s',
    async (norm) => {
      const factor = (await singleYearMoneyFactor(source, norm, 2025))._unsafeUnwrap();
      const money = new OracleDecimal('9007199254740993.01');
      const expected =
        norm === 'PERCENT_GDP' ? money.div('1916404900000').mul(100) : money.div('5.0415');
      expect(money.mul(factor).toFixed(2)).toBe(expected.toFixed(2));
    }
  );
  it('does not load factors for nominal RON', async () => {
    const yearly = vi.fn(source.yearly);
    for (const norm of ['TOTAL', 'PER_CAPITA'] as const)
      expect((await singleYearMoneyFactor({ yearly }, norm, 2026))._unsafeUnwrap()).toBe('1');
    expect(yearly).not.toHaveBeenCalled();
  });
  it.each([2023, 2026])('refuses missing year %s without carry-forward', async (year) => {
    expect((await singleYearMoneyFactor(source, 'TOTAL_EURO', year)).isErr()).toBe(true);
  });
  it('propagates admission failure and retains only the explicit compatibility path', async () => {
    const failed: FactorSource = {
      yearly: async () => err({ type: 'ServiceUnavailable', message: 'Unadmitted snapshot' }),
    };
    expect(
      (await singleYearMoneyFactor(failed, 'TOTAL_EURO', 2025))._unsafeUnwrapErr().message
    ).toBe('Unadmitted snapshot');
    expect((await singleYearMoneyFactor(undefined, 'TOTAL_EURO', 2025))._unsafeUnwrap()).toBe(
      String(1 / 5.05)
    );
  });
});
