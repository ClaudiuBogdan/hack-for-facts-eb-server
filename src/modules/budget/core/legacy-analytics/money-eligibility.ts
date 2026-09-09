/**
 * Which selected years a money normalization can serve, and with which CPI base
 * year — the one rule both the SQL-level factor path (`shell/repo/money-factor.ts`)
 * and the in-memory native path (`native-normalize.ts`) apply (review B/F18: the
 * block used to be copied, with a `Math.max()` of an empty CPI map on one side).
 */
import { err, ok, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import type { NormalizationContext } from './normalize.js';
import type { NormalizationPlan } from './types.js';

export type MoneyPlanShape = Pick<NormalizationPlan, 'mode' | 'currency' | 'inflationAdjusted'>;

export interface MoneyEligibility {
  /** Selected years every required factor covers, in the input order. */
  readonly eligible: readonly number[];
  /** The latest CPI year (the real-terms base); undefined without a CPI series. */
  readonly baseYear: number | undefined;
}

export const eligibleMoneyYears = (
  plan: MoneyPlanShape,
  context: NormalizationContext,
  years: readonly number[]
): Result<MoneyEligibility, ApiError> => {
  const required =
    plan.mode === 'percent_gdp'
      ? [context.gdp]
      : [
          ...(plan.inflationAdjusted ? [context.cpiIndex] : []),
          ...(plan.currency !== 'RON' ? [context.fxRate] : []),
        ];
  for (const series of required) {
    if (series === undefined) return err(serviceUnavailable('Missing monetary factor kind'));
    if ([...series.values()].some((value) => !value.isFinite() || value.lte(0)))
      return err(serviceUnavailable('Invalid monetary factor value'));
  }
  const baseYear =
    context.cpiIndex === undefined
      ? undefined
      : [...context.cpiIndex.keys()].sort((a, b) => b - a)[0];
  if (plan.mode !== 'percent_gdp' && plan.inflationAdjusted && baseYear === undefined)
    return err(serviceUnavailable('CPI base year is unavailable'));
  const eligible = years.filter((year) => {
    if (plan.mode === 'percent_gdp') return context.gdp?.has(year) === true;
    if (plan.inflationAdjusted && context.cpiIndex?.has(year) !== true) return false;
    if (plan.currency === 'RON') return true;
    const rateYear = plan.inflationAdjusted ? baseYear : year;
    return rateYear !== undefined && context.fxRate?.has(rateYear) === true;
  });
  return ok({ eligible, baseYear });
};
