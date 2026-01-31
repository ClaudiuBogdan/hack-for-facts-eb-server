import { Decimal } from 'decimal.js';

import { Frequency } from '@/common/types/temporal.js';

import type { Currency, NormalizationMode } from '@/common/types/analytics.js';
import type { NormalizationFactors } from '@/modules/normalization/index.js';

export interface NormalizationConfig {
  normalization: NormalizationMode;
  currency: Currency;
  inflation_adjusted: boolean;
}

export function needsNormalization(config: NormalizationConfig): boolean {
  if (config.normalization === 'percent_gdp') return true;
  if (config.inflation_adjusted) return true;
  return config.currency !== 'RON';
}

/**
 * Computes a normalization multiplier for a single period label.
 *
 * This multiplier applies:
 * - CPI inflation adjustment (multiply)
 * - FX conversion (divide by rate)
 * - percent_gdp conversion (100 / GDP)
 * - optional external per-capita division (divide by population denominator)
 */
export function computeMultiplier(
  periodLabel: string,
  config: NormalizationConfig,
  factors: NormalizationFactors,
  populationDenominator?: Decimal
): Decimal {
  if (config.normalization === 'percent_gdp') {
    const gdp = factors.gdp.get(periodLabel);
    if (gdp === undefined || gdp.isZero()) return new Decimal(0);
    const base = new Decimal(100).div(gdp);
    if (populationDenominator !== undefined && !populationDenominator.isZero()) {
      // TODO(review): percent_gdp + per_capita shouldn't be requested; treat as per-capita on the derived %.
      return base.div(populationDenominator);
    }
    return base;
  }

  let mult = new Decimal(1);

  if (config.inflation_adjusted) {
    const cpi = factors.cpi.get(periodLabel);
    if (cpi !== undefined) {
      mult = mult.mul(cpi);
    }
  }

  if (config.currency !== 'RON') {
    const rateMap = config.currency === 'EUR' ? factors.eur : factors.usd;
    const rate = rateMap.get(periodLabel);
    if (rate !== undefined && !rate.isZero()) {
      mult = mult.div(rate);
    }
  }

  if (config.normalization === 'per_capita') {
    if (populationDenominator !== undefined && !populationDenominator.isZero()) {
      mult = mult.div(populationDenominator);
    } else {
      // Keep the value unchanged if we cannot compute a denominator (consistent with existing behavior).
      // TODO(review): consider returning a validation error instead for per-capita requests.
    }
  }

  return mult;
}

export function periodLabelFromParts(
  year: number,
  periodValue: number,
  frequency: Frequency
): string {
  if (frequency === Frequency.MONTH) {
    return `${String(year)}-${String(periodValue).padStart(2, '0')}`;
  }
  if (frequency === Frequency.QUARTER) {
    return `${String(year)}-Q${String(periodValue)}`;
  }
  return String(year);
}
