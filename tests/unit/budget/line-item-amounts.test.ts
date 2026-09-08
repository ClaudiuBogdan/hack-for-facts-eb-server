import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { normalizeLineItemAmounts } from '@/modules/budget/core/line-item-amounts.js';
import { availableSingleYearMoneyFactor } from '@/modules/budget/shell/repo/money-factor.js';

import type { FactorSource } from '@/modules/budget/core/legacy-analytics/ports.js';
const Oracle = Decimal.clone({ precision: 80 });
describe('direct line-item normalization', () => {
  it('preserves cancelling amounts, zero, null quarters and independent high precision', () => {
    const values = ['9007199254740993.01', '-9007199254740993.01', '0'];
    for (const value of values) {
      const actual = normalizeLineItemAmounts(
        { ytdAmount: value, monthlyAmount: value, quarterlyAmount: null },
        '0.2',
        '7'
      );
      expect(new Oracle(actual.ytdAmount).toFixed(12)).toBe(new Oracle(value).div(35).toFixed(12));
      expect(actual.monthlyAmount).toBe(actual.ytdAmount);
      expect(actual.quarterlyAmount).toBeNull();
    }
  });
  it('keeps unavailable coverage distinct from missing kinds and admission failures', async () => {
    const gap: FactorSource = { yearly: async () => ok(new Map([[2024, new Decimal('4.9746')]])) };
    expect(
      (await availableSingleYearMoneyFactor(gap, 'TOTAL_EURO', 2025))._unsafeUnwrap()
    ).toBeNull();
    const missing: FactorSource = { yearly: async () => ok(null) };
    expect((await availableSingleYearMoneyFactor(missing, 'TOTAL_EURO', 2025)).isErr()).toBe(true);
    const denied: FactorSource = {
      yearly: async () => err({ type: 'ServiceUnavailable', message: 'admission failed' }),
    };
    expect(
      (await availableSingleYearMoneyFactor(denied, 'TOTAL_EURO', 2025))._unsafeUnwrapErr().message
    ).toBe('admission failed');
  });
  it.each(['0', '-1', 'NaN', 'Infinity'])('rejects invalid admitted factor %s', async (value) => {
    const source: FactorSource = { yearly: async () => ok(new Map([[2025, new Decimal(value)]])) };
    expect((await availableSingleYearMoneyFactor(source, 'TOTAL_EURO', 2025)).isErr()).toBe(true);
  });
});
