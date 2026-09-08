/** Normalize bounded fact-page values without deriving anything from aggregate totals. */
import { legacyDecimal } from './legacy-analytics/decimal.js';

import type { ExecutionLineItem, ExecutionNormalizedAmounts } from './types.js';

export function normalizeLineItemAmounts(
  item: Pick<ExecutionLineItem, 'ytdAmount' | 'monthlyAmount' | 'quarterlyAmount'>,
  multiplier: string,
  population = '1'
): ExecutionNormalizedAmounts {
  const amount = (value: string) => legacyDecimal(value).mul(multiplier).div(population).toFixed();
  return {
    ytdAmount: amount(item.ytdAmount),
    monthlyAmount: amount(item.monthlyAmount),
    quarterlyAmount: item.quarterlyAmount === null ? null : amount(item.quarterlyAmount),
  };
}
