/** Additive money options; legacy euro normalizations retain their currency. */
import type { BudgetNormalization } from './constants.js';
import type { NormalizationPlan } from './legacy-analytics/types.js';

export interface BudgetMoneyOptions {
  readonly currency?: 'RON' | 'EUR' | 'USD';
  readonly inflationAdjusted?: boolean;
}

export const budgetMoneyPlan = (
  normalization: BudgetNormalization,
  options: BudgetMoneyOptions = {}
): NormalizationPlan => ({
  mode: normalization === 'PERCENT_GDP' ? 'percent_gdp' : 'total',
  currency:
    normalization === 'PERCENT_GDP'
      ? 'RON'
      : normalization === 'TOTAL_EURO' || normalization === 'PER_CAPITA_EURO'
        ? 'EUR'
        : (options.currency ?? 'RON'),
  inflationAdjusted: normalization !== 'PERCENT_GDP' && options.inflationAdjusted === true,
  showPeriodGrowth: false,
});

export const needsMoneyFactor = (
  normalization: BudgetNormalization,
  options: BudgetMoneyOptions = {}
) => {
  const plan = budgetMoneyPlan(normalization, options);
  return plan.mode === 'percent_gdp' || plan.currency !== 'RON' || plan.inflationAdjusted;
};
