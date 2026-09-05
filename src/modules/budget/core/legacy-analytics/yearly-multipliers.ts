/** Exact-year money normalization for native grouped analytics. No population here. */
import { err, ok, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { HUNDRED, legacyDecimal } from './decimal.js';

import type { NormalizationContext } from './normalize.js';
import type { NormalizationPlan, YearlySeries } from './types.js';
import type { Decimal } from 'decimal.js';

const positiveValue = (
  series: YearlySeries | undefined,
  year: number,
  kind: string
): Result<Decimal, ApiError> => {
  const value = series?.get(year);
  if (value === undefined || !value.isFinite() || value.lte(0)) {
    return err(serviceUnavailable(`${kind} is unavailable for ${String(year)}`));
  }
  return ok(legacyDecimal(value));
};

/** Each requested year has its own multiplier. Missing coverage aborts, never substitutes. */
export const exactYearMoneyMultipliers = (
  plan: NormalizationPlan,
  context: NormalizationContext,
  years: readonly number[]
): Result<YearlySeries, ApiError> => {
  const multipliers = new Map<number, Decimal>();
  const cpiBaseYear =
    context.cpiIndex === undefined
      ? undefined
      : [...context.cpiIndex.keys()].sort((a, b) => b - a)[0];
  for (const year of years) {
    let multiplier = legacyDecimal(1);
    if (plan.mode === 'percent_gdp') {
      const gdp = positiveValue(context.gdp, year, 'GDP');
      if (gdp.isErr()) return err(gdp.error);
      multiplier = HUNDRED.div(gdp.value);
    } else {
      if (plan.inflationAdjusted) {
        if (cpiBaseYear === undefined) return err(serviceUnavailable('CPI is unavailable'));
        const base = positiveValue(context.cpiIndex, cpiBaseYear, 'CPI');
        if (base.isErr()) return err(base.error);
        const level = positiveValue(context.cpiIndex, year, 'CPI');
        if (level.isErr()) return err(level.error);
        multiplier = base.value.div(level.value);
      }
      if (plan.currency !== 'RON') {
        const rate = positiveValue(context.fxRate, year, `${plan.currency} exchange rate`);
        if (rate.isErr()) return err(rate.error);
        multiplier = multiplier.div(rate.value);
      }
    }
    multipliers.set(year, multiplier);
  }
  return ok(multipliers);
};
